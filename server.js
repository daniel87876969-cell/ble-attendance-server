const express = require('express');
const mysql = require('mysql2');
const nodemailer = require('nodemailer');
const cors = require('cors');
const bodyParser = require('body-parser');
const crypto = require('crypto');
const http = require('http');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.text({ type: ['text/csv', 'text/plain'] }));

// ==========================================
// 🚨 全域錯誤日誌記錄器 (Console & error.log)
// ==========================================
const ERROR_LOG_PATH = path.join(__dirname, 'error.log');

function logSystemError(title, err, req = null) {
    const timestamp = new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' });
    let reqInfo = '無 HTTP Context';
    if (req) {
        reqInfo = `${req.method} ${req.originalUrl} | IP: ${req.ip || req.connection.remoteAddress} | Body: ${JSON.stringify(req.body || {})}`;
    }

    const logEntry = `
============================== [ERROR ALERT] ==============================
⏰ 時間: ${timestamp}
📌 類型: ${title}
🌐 請求: ${reqInfo}
⚠️ 訊息: ${err && err.message ? err.message : err}
📑 堆疊 (Stack Trace):
${err && err.stack ? err.stack : '無詳細堆疊追蹤'}
===========================================================================
`;

    console.error(logEntry);
    fs.appendFile(ERROR_LOG_PATH, logEntry + '\n', (fsErr) => {
        if (fsErr) console.error('❌ 寫入 error.log 失敗:', fsErr);
    });
}

process.on('uncaughtException', (err) => {
    logSystemError('Uncaught Exception (未捕獲例外)', err);
});

process.on('unhandledRejection', (reason) => {
    logSystemError('Unhandled Rejection (未處理的 Promise 拒絕)', reason);
});

app.get('/', (req, res) => {
    res.sendFile(__dirname + '/index.html');
});

// ==========================================
// 身分判斷與安全輔助函式
// ==========================================
function getRoleByEmail(email) {
    if (!email) return 'student';
    const lowerEmail = email.toLowerCase().trim();
    if (lowerEmail.endsWith('@mail.mcu.edu.tw')) {
        return 'teacher';
    }
    return 'student';
}

function generateSecureSessionId() {
    return crypto.randomBytes(8).toString('hex');
}

// 預設 5 位專案組員修課名單 (課程 ID 1 專用)
const COURSE_ENROLLED_STUDENTS = [
    { id: "12360305", name: "組員A" },
    { id: "12360615", name: "組員B" },
    { id: "12360596", name: "組員E" },
    { id: "12360651", name: "組員D(0651)" },
    { id: "12363033", name: "組員C(3033)" }
];

// 預設可登入之 7 位學生帳號 (5 位組員 + 2 位測試未修課帳號)
const ALL_TEST_USERS = [
    { id: "12360305", name: "組員A", email: "12360305@me.mcu.edu.tw" },
    { id: "12360615", name: "組員B", email: "12360615@me.mcu.edu.tw" },
    { id: "12360596", name: "組員E", email: "12360596@me.mcu.edu.tw" },
    { id: "12360651", name: "組員D(0651)", email: "12360651@me.mcu.edu.tw" },
    { id: "12363033", name: "組員C(3033)", email: "12363033@me.mcu.edu.tw" },
    { id: "12360333", name: "未選課測試生A", email: "12360333@me.mcu.edu.tw" },
    { id: "12360342", name: "未選課測試生B", email: "12360342@me.mcu.edu.tw" }
];

// ==========================================
// 1. 資料庫連線池設定 (抗斷連 + 自動重連)
// ==========================================
const db = mysql.createPool({
    host: 'localhost',
    user: 'root',
    password: 'knowledge',
    database: 'ble_mcu',
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    enableKeepAlive: true,
    keepAliveInitialDelay: 10000
});

let activeCourseSessions = {}; 
let activeSessions = {};
let activeSessionsById = {};
let tempCodes = {};
let coordBuffer = {};

db.getConnection((err, connection) => {
    if (err) {
        logSystemError('資料庫連線池初始化失敗', err);
    } else {
        console.log('✅ 資料庫連線池初始化成功！');
        connection.release();

        // 確保 user 表結構包含 role 欄位，且 password 欄位允許為 NULL (供匯入未註冊之學生使用)
        const checkRoleColumnSql = `
            SELECT COUNT(*) AS count 
            FROM information_schema.COLUMNS 
            WHERE TABLE_SCHEMA = 'ble_mcu' 
              AND TABLE_NAME = 'user' 
              AND COLUMN_NAME = 'role';
        `;
        db.query(checkRoleColumnSql, (cErr, cResults) => {
            if (!cErr && cResults[0].count === 0) {
                db.query("ALTER TABLE user ADD COLUMN role VARCHAR(20) DEFAULT 'student';", () => {});
            }
        });
        db.query("ALTER TABLE user MODIFY COLUMN password VARCHAR(255) NULL;", () => {});

        // 建立課程總表 courses
        const createCoursesTableSql = `
            CREATE TABLE IF NOT EXISTS courses (
                id INT AUTO_INCREMENT PRIMARY KEY,
                course_code VARCHAR(50),
                course_name VARCHAR(100) NOT NULL,
                teacher_id VARCHAR(50) NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `;
        db.query(createCoursesTableSql, (tErr) => {
            if (!tErr) {
                console.log('📚 [資料庫] courses 表已就緒');
                const checkDefaultCourseSql = 'SELECT * FROM courses WHERE id = 1';
                db.query(checkDefaultCourseSql, (cdErr, cdRes) => {
                    if (!cdErr && cdRes.length === 0) {
                        const initCourseSql = `
                            INSERT INTO courses (id, course_code, course_name, teacher_id)
                            VALUES (1, 'MCU_BLE_PROJECT', '行動應用與物聯網專案實作', 'teacher@mail.mcu.edu.tw');
                        `;
                        db.query(initCourseSql, () => {
                            console.log('🎯 [預設課程初始化] 已建立預設課程 1: 行動應用與物聯網專案實作');
                        });
                    }
                });
            }
        });

        // 建立並同步修課名單表 course_students
        const createCourseStudentsTableSql = `
            CREATE TABLE IF NOT EXISTS course_students (
                id INT AUTO_INCREMENT PRIMARY KEY,
                course_id INT NOT NULL,
                student_id VARCHAR(50) NOT NULL,
                student_name VARCHAR(100),
                UNIQUE KEY unique_course_student (course_id, student_id)
            );
        `;
        db.query(createCourseStudentsTableSql, (tErr) => {
            if (!tErr) {
                console.log('👥 [資料庫] course_students 表已就緒');
                db.query('DELETE FROM course_students WHERE course_id = 1', () => {
                    const studentValues = COURSE_ENROLLED_STUDENTS.map(s => [1, s.id, s.name]);
                    const insertDefStudentsSql = 'INSERT IGNORE INTO course_students (course_id, student_id, student_name) VALUES ?';
                    db.query(insertDefStudentsSql, [studentValues], (isErr) => {
                        if (!isErr) {
                            console.log('👥 [資料庫同步] 課程 1 名單更新完成（5 位組員名單已就緒）！');
                        }
                    });
                });
            }
        });

        // 建立 App v6.1 專用課表與名單儲存表 teacher_schedules
        const createTeacherSchedulesTableSql = `
            CREATE TABLE IF NOT EXISTS teacher_schedules (
                id INT AUTO_INCREMENT PRIMARY KEY,
                teacher_email VARCHAR(255) NOT NULL,
                schedule_data LONGTEXT,
                students_data LONGTEXT,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                UNIQUE KEY unique_teacher_schedule (teacher_email)
            );
        `;
        db.query(createTeacherSchedulesTableSql, (tsErr) => {
            if (!tsErr) console.log('🗓️ [資料庫] teacher_schedules 課表表已就緒');
        });

        // 初始化 7 位測試學生帳號 (密碼預設 123456，完全解除裝置限制)
        ALL_TEST_USERS.forEach(u => {
            const sqlInsertUser = `
                INSERT INTO user (user_id, name, password, email, device_id, role)
                VALUES (?, ?, '123456', ?, 'ANY_DEVICE', 'student')
                ON DUPLICATE KEY UPDATE device_id = 'ANY_DEVICE';
            `;
            db.query(sqlInsertUser, [u.id, u.name, u.email]);
        });
        console.log('🔓 [免綁定設定] 7 位學生帳號已全部確認可登入 (裝置限制已解除)！');

        // 初始化教師帳號：預設老師與全空白課表測試老師
        const initTeacherSql = `
            INSERT INTO user (user_id, name, password, email, device_id, role) 
            VALUES ('T001', '指導老師', 'teacher123', 'teacher@mail.mcu.edu.tw', 'ANY_DEVICE', 'teacher') 
            ON DUPLICATE KEY UPDATE name='指導老師', password='teacher123', email='teacher@mail.mcu.edu.tw', device_id='ANY_DEVICE', role='teacher';
        `;
        db.query(initTeacherSql, () => {
            console.log('👨‍🏫 [系統就緒] 預設老師帳號 (teacher@mail.mcu.edu.tw) 已確認就緒！');
        });

        const initNewTeacherSql = `
            INSERT INTO user (user_id, name, password, email, device_id, role) 
            VALUES ('T002', '全新測試老師', 'teacher123', 'newteacher@mail.mcu.edu.tw', 'ANY_DEVICE', 'teacher') 
            ON DUPLICATE KEY UPDATE name='全新測試老師', password='teacher123', email='newteacher@mail.mcu.edu.tw', device_id='ANY_DEVICE', role='teacher';
        `;
        db.query(initNewTeacherSql, () => {
            console.log('🆕 [測試帳號就緒] 全空白課表測試老師 (newteacher@mail.mcu.edu.tw) 已就緒！');
        });
    }
});

const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: process.env.SMTP_MAIL,
        pass: process.env.SMTP_KEY
    }
});

// ==========================================
// 2. 帳號與登入接口 (學生註冊後才正式設定密碼)
// ==========================================

app.post('/api/send-code', (req, res) => {
    const { email } = req.body;
    if (!email || (!email.endsWith('@me.mcu.edu.tw') && !email.endsWith('@mail.mcu.edu.tw'))) {
        return res.status(403).json({ success: false, message: '限用學校信箱' });
    }

    const role = getRoleByEmail(email);
    const code = Math.floor(100000 + Math.random() * 900000).toString(); 
    tempCodes[email] = { code, expires: Date.now() + 300000, role }; 

    const mailOptions = {
        from: `"藍牙點名系統" <${process.env.SMTP_MAIL || 'admin@mcu.edu.tw'}>`,
        to: email,
        subject: `【點名系統】${role === 'teacher' ? '教師' : '學生'}註冊驗證碼`,
        text: `您好！您的驗證碼是：${code}\n請於 5 分鐘內輸入此代碼以完成註冊與密碼設定。`
    };

    transporter.sendMail(mailOptions, (err) => {
        if (err) {
            logSystemError('寄送驗證碼失敗', err, req);
            return res.status(500).json({ success: false, message: '寄信失敗' });
        }
        res.status(200).json({ success: true, message: 'Sent', role });
    });
});

// 學生親自註冊設定密碼
app.post('/api/register', (req, res) => {
    const { user_id, name, email, password, code } = req.body;
    const record = tempCodes[email];
    if (!record) return res.status(400).json({ success: false, message: '請先獲取驗證碼' });
    if (record.code !== code) return res.status(400).json({ success: false, message: '驗證碼錯誤' });
    if (Date.now() > record.expires) return res.status(400).json({ success: false, message: '驗證碼已過期' });

    const role = getRoleByEmail(email);
    const finalDeviceId = 'ANY_DEVICE';

    // 若帳號已先由課表預先匯入，此處更新其密碼完成正式註冊；若無則直接新增
    const sql = `
        INSERT INTO user (user_id, name, password, email, device_id, role) 
        VALUES (?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE 
            name = VALUES(name),
            password = VALUES(password),
            device_id = 'ANY_DEVICE';
    `;
    db.query(sql, [user_id, name, password, email, finalDeviceId, role], (err) => {
        if (err) {
            logSystemError('註冊寫入密碼失敗', err, req);
            return res.status(500).json({ success: false, message: '資料庫錯誤' });
        }
        delete tempCodes[email];
        console.log(`👤 [學生註冊成功] 學號: ${user_id} (${email}) 已完成密碼設定！`);
        res.status(200).json({ success: true, status: 'success', message: 'Success', role: role });
    });
});

app.post('/api/auth/login', (req, res) => {
    const { email, password } = req.body;

    if (!email || !password) {
        return res.status(400).json({ success: false, message: '請填寫信箱與密碼' });
    }

    const cleanEmail = email.toLowerCase().trim();
    const inferredRole = getRoleByEmail(cleanEmail);

    const sql = 'SELECT * FROM user WHERE email = ?';
    db.query(sql, [cleanEmail], (err, results) => {
        if (err) {
            logSystemError('登入查詢資料庫失敗', err, req);
            return res.status(500).json({ success: false, message: '資料庫錯誤' });
        }
        if (!results || results.length === 0) {
            return res.status(401).json({ success: false, message: '此帳號尚未存在或尚未匯入' });
        }

        const user = results[0];

        // 檢查學生是否尚未親自註冊設定密碼
        if (!user.password) {
            return res.status(401).json({ 
                success: false, 
                message: '此學號已由課表匯入，但尚未完成正式註冊，請先點擊註冊並設定您的密碼！' 
            });
        }

        // 檢查密碼
        if (user.password !== password) {
            return res.status(401).json({ success: false, message: '信箱或密碼錯誤' });
        }

        const userRole = user.role || inferredRole;

        if (userRole === 'teacher') {
            if (!cleanEmail.endsWith('@mail.mcu.edu.tw')) {
                return res.status(403).json({ success: false, message: '教師端僅限使用 @mail.mcu.edu.tw 信箱登入' });
            }
            console.log(`👨‍🏫 [教師登入成功] ${cleanEmail}`);
            return res.status(200).json({
                success: true,
                status: 'success',
                message: 'Success',
                role: 'teacher',
                token: 'mock_token_' + user.user_id,
                user: { user_id: user.user_id, name: user.name, email: user.email, role: 'teacher' }
            });
        }

        console.log(`🎓 [學生登入成功] 學號: ${user.user_id} (${cleanEmail})`);
        return res.status(200).json({
            success: true,
            status: 'success',
            message: 'Success',
            role: 'student',
            token: 'mock_token_' + user.user_id,
            user: { user_id: user.user_id, name: user.name, email: user.email, role: 'student' }
        });
    });
});

// ==========================================
// 3. 課表雙向同步 API (同名分 1、2 + 學生帳號預先建置)
// ==========================================

app.post('/api/teacher/schedule/sync', (req, res) => {
    const { email, schedule, students } = req.body;

    if (!email) {
        return res.status(400).json({ success: false, message: '缺少老師信箱 (email)' });
    }

    const cleanEmail = email.toLowerCase().trim();
    const scheduleStr = typeof schedule === 'object' ? JSON.stringify(schedule) : (schedule || "");
    const studentsStr = typeof students === 'object' ? JSON.stringify(students) : (students || "");

    // 1. 先將課表原始 JSON 寫入 teacher_schedules 表
    const sqlUpsert = `
        INSERT INTO teacher_schedules (teacher_email, schedule_data, students_data)
        VALUES (?, ?, ?)
        ON DUPLICATE KEY UPDATE 
            schedule_data = VALUES(schedule_data),
            students_data = VALUES(students_data),
            updated_at = CURRENT_TIMESTAMP;
    `;

    db.query(sqlUpsert, [cleanEmail, scheduleStr, studentsStr], (err) => {
        if (err) {
            logSystemError('課表同步寫入 teacher_schedules 失敗', err, req);
            return res.status(500).json({ success: false, message: '資料庫寫入課表失敗' });
        }

        console.log(`📥 [課表與名單同步] 老師: ${cleanEmail} 原始課表已暫存，處理同名分班與學生帳號...`);

        // 2. 解析學生名單 JSON，自動建立課程與學生修課關係
        try {
            const parsedStudents = typeof students === 'string' ? JSON.parse(students || "{}") : (students || {});
            const courseNames = Object.keys(parsedStudents);

            if (courseNames.length === 0) {
                return res.status(200).json({ success: true, message: '課表已儲存 (無學生名單需要匯入)' });
            }

            // 處理每門課
            courseNames.forEach((baseCourseName) => {
                const studentList = parsedStudents[baseCourseName] || [];
                if (!Array.isArray(studentList) || studentList.length === 0) return;

                // 檢查同名課程：若已有相同課程名稱，自動在後方加上 1、2...
                const sqlCheckSameName = `
                    SELECT course_name FROM courses 
                    WHERE teacher_id = ? AND (course_name = ? OR course_name LIKE ?)
                    ORDER BY id ASC;
                `;
                db.query(sqlCheckSameName, [cleanEmail, baseCourseName, `${baseCourseName} %`], (chkErr, existingCourses) => {
                    if (chkErr) return logSystemError('查詢同名課程失敗', chkErr, req);

                    let finalCourseName = baseCourseName;
                    if (existingCourses && existingCourses.length > 0) {
                        const count = existingCourses.length;
                        finalCourseName = `${baseCourseName} ${count}`;
                    }

                    const courseCode = 'COURSE_' + crypto.createHash('md5').update(finalCourseName + Date.now()).digest('hex').substring(0, 8);
                    const sqlInsertCourse = `
                        INSERT INTO courses (course_code, course_name, teacher_id)
                        VALUES (?, ?, ?);
                    `;

                    db.query(sqlInsertCourse, [courseCode, finalCourseName, cleanEmail], (cErr, cResult) => {
                        if (cErr) return logSystemError(`建立課程 ${finalCourseName} 失敗`, cErr, req);
                        const newCourseId = cResult.insertId;

                        // 將名單內學生預先建立至 user 表，密碼設為 NULL (等待學生自行註冊驗證)
                        studentList.forEach(st => {
                            const studentId = (st.id || st.student_id || '').toString().trim();
                            const studentName = st.name || st.student_name || `學生_${studentId}`;
                            if (!studentId) return;

                            const studentEmail = `${studentId}@me.mcu.edu.tw`;
                            const sqlInsertUser = `
                                INSERT INTO user (user_id, name, password, email, device_id, role)
                                VALUES (?, ?, NULL, ?, 'ANY_DEVICE', 'student')
                                ON DUPLICATE KEY UPDATE 
                                    name = VALUES(name),
                                    device_id = 'ANY_DEVICE';
                            `;
                            db.query(sqlInsertUser, [studentId, studentName, studentEmail], (uErr) => {
                                if (uErr) logSystemError(`預建學生帳號 ${studentId} 失敗`, uErr, req);
                            });
                        });

                        // 建立課程與學生的修課關係
                        const enrollValues = studentList
                            .filter(st => (st.id || st.student_id))
                            .map(st => [newCourseId, (st.id || st.student_id).toString().trim(), st.name || st.student_name || '']);

                        if (enrollValues.length > 0) {
                            const sqlEnroll = `INSERT IGNORE INTO course_students (course_id, student_id, student_name) VALUES ?;`;
                            db.query(sqlEnroll, [enrollValues], (eErr) => {
                                if (eErr) {
                                    logSystemError(`課程 ${finalCourseName} 關聯修課名單失敗`, eErr, req);
                                } else {
                                    console.log(`🎓 [課程建立成功] 課程:【${finalCourseName}】(ID: ${newCourseId})，共 ${enrollValues.length} 位學生！(密碼待親自註冊設定)`);
                                }
                            });
                        }
                    });
                });
            });

            return res.status(200).json({
                success: true,
                message: '課表與名單同步成功，同名課程已自動編號，學生帳號已建立！'
            });

        } catch (parseError) {
            logSystemError('解析 students JSON 格式錯誤', parseError, req);
            return res.status(200).json({ success: true, message: '課表已儲存，學生名單格式錯誤未解析' });
        }
    });
});

app.post('/api/teacher/schedule/get', (req, res) => {
    const { email } = req.body;

    if (!email) {
        return res.status(400).json({ success: false, message: '請提供 email' });
    }

    const cleanEmail = email.toLowerCase().trim();
    const sqlQuery = 'SELECT schedule_data, students_data FROM teacher_schedules WHERE teacher_email = ?';

    db.query(sqlQuery, [cleanEmail], (err, rows) => {
        if (err) {
            logSystemError('查詢課表錯誤', err, req);
            return res.status(500).json({ success: false, message: '伺服器查詢錯誤' });
        }

        if (rows && rows.length > 0 && rows[0].schedule_data) {
            return res.status(200).json({
                success: true,
                schedule: rows[0].schedule_data,
                students: rows[0].students_data || ""
            });
        }

        return res.status(200).json({
            success: true,
            schedule: "",
            students: ""
        });
    });
});

// ==========================================
// 4. 固定 OTP 點名 Session 接口 (整堂課不更換)
// ==========================================

function notifyPositioningServer(configData) {
    const postData = JSON.stringify(configData);
    const options = {
        hostname: '127.0.0.1',
        port: 8020,
        path: '/api/session/config',
        method: 'POST',
        headers: {
            'Content-Type': 'application/json; charset=UTF-8',
            'Content-Length': Buffer.byteLength(postData)
        },
        timeout: 5000
    };

    const req = http.request(options, (res) => {
        let resBody = '';
        res.on('data', chunk => { resBody += chunk; });
    });

    req.on('error', () => {});
    req.on('timeout', () => { req.destroy(); });
    req.write(postData);
    req.end();
}

// 老師開始點名 (整個點名階段產生一次固定 OTP，不再輪替)
app.post('/api/session/start', (req, res) => {
    const { email, password } = req.body;
    const course_id = req.body.course_id ? parseInt(req.body.course_id) : 1;

    if (!email) {
        return res.status(400).json({ success: false, message: '請提供 email' });
    }

    const proceedStart = () => {
        const sqlCourse = 'SELECT * FROM courses WHERE id = ?';
        db.query(sqlCourse, [course_id], (cErr, courseResults) => {
            if (cErr) {
                logSystemError('啟動點名查詢課程失敗', cErr, req);
                return res.status(500).json({ success: false, message: '資料庫錯誤' });
            }

            const courseName = (courseResults && courseResults.length > 0) ? courseResults[0].course_name : "行動應用與物聯網專案實作";
            const courseCode = (courseResults && courseResults.length > 0) ? courseResults[0].course_code : "MCU_BLE_PROJECT";

            const sqlStudents = 'SELECT student_id, student_name FROM course_students WHERE course_id = ?';
            db.query(sqlStudents, [course_id], (sErr, studentResults) => {
                if (sErr) {
                    logSystemError('啟動點名查詢學生名單失敗', sErr, req);
                    return res.status(500).json({ success: false, message: '資料庫錯誤' });
                }

                const xorKey = Math.floor(10000000 + Math.random() * 90000000).toString();
                const sessionId = generateSecureSessionId();
                let studentOtpMap = {};
                let studentRawList = {};

                const studentsToUse = (studentResults && studentResults.length > 0) 
                    ? studentResults 
                    : COURSE_ENROLLED_STUDENTS.map(s => ({ student_id: s.id, student_name: s.name }));

                studentsToUse.forEach(s => {
                    const otp = Math.floor(100000 + Math.random() * 900000).toString();
                    studentOtpMap[s.student_id] = otp;
                    studentRawList[s.student_id] = s.student_name;
                });

                const cleanEmail = email.toLowerCase().trim();
                const sessionData = {
                    session_id: sessionId,
                    course_id: course_id,
                    course_name: courseName,
                    course_code: courseCode,
                    teacher_email: cleanEmail,
                    xor_key: xorKey,
                    students: studentOtpMap,
                    studentRawList: studentRawList,
                    started_at: Date.now()
                };

                activeCourseSessions[course_id] = sessionData;
                activeSessions[cleanEmail] = sessionData;
                activeSessionsById[sessionId] = sessionData;

                coordBuffer[sessionId] = {
                    coordinateSystem: "grid32",
                    updatedAt: new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' }),
                    students: {}
                };

                console.log('\n===========================================================');
                console.log(`📢 [老師點名啟動] 課程: ${courseName} (ID: ${course_id})`);
                console.log(`🔑 本次 Session ID: ${sessionId} | 固定 XOR Key: ${xorKey}`);
                console.log(`👥 本次點名學生固定 OTP 表：`);
                Object.keys(studentOtpMap).forEach(sid => {
                    console.log(`   👉 學號: ${sid} (${studentRawList[sid] || '學生'}) -> 固定 OTP: ${studentOtpMap[sid]}`);
                });
                console.log(`🔒 全程使用固定 OTP，不再每 30 秒換碼`);
                console.log('===========================================================');

                notifyPositioningServer({
                    session_id: sessionId,
                    xor_key: xorKey,
                    otp_list: studentOtpMap,
                    timeout: 5
                });

                res.status(200).json({
                    success: true,
                    status: "success",
                    course_id: course_id,
                    course_name: courseName,
                    session_id: sessionId,
                    xor_key: xorKey,
                    otp_interval_seconds: 0
                });
            });
        });
    };

    if (password) {
        db.query('SELECT * FROM user WHERE email = ? AND password = ?', [email.toLowerCase().trim(), password], (err, rows) => {
            if (err) {
                logSystemError('啟動點名驗證教師密碼失敗', err, req);
                return res.status(500).json({ status: 'failed', message: '資料庫錯誤' });
            }
            if (!rows || rows.length === 0) {
                return res.status(401).json({ status: 'failed', reason: 'invalid_credentials', message: '帳號或密碼錯誤' });
            }
            proceedStart();
        });
    } else {
        proceedStart();
    }
});

// 老師端查詢 OTP 名單 (整堂固定)
app.post('/api/session/otp-list', (req, res) => {
    const { email, course_id, session_id } = req.body;
    
    let session = null;
    if (session_id && activeSessionsById[session_id]) {
        session = activeSessionsById[session_id];
    } else if (course_id && activeCourseSessions[course_id]) {
        session = activeCourseSessions[course_id];
    } else if (email && activeSessions[email.toLowerCase().trim()]) {
        session = activeSessions[email.toLowerCase().trim()];
    } else {
        const allCourseIds = Object.keys(activeCourseSessions);
        if (allCourseIds.length > 0) session = activeCourseSessions[allCourseIds[0]];
    }

    if (!session) {
        return res.status(404).json({ success: false, message: '目前未開啟任何點名 Session' });
    }

    res.status(200).json({
        success: true,
        session_id: session.session_id,
        course_name: session.course_name,
        xor_key: session.xor_key,
        otp_list: session.students,
        remaining_seconds: 9999
    });
});

// 學生端獲取點名權杖 (整堂固定)
app.post('/api/session/get-token', (req, res) => {
    const { student_id } = req.body;
    const course_id = req.body.course_id ? parseInt(req.body.course_id) : 1;

    if (!student_id) {
        return res.status(400).json({ success: false, message: '請提供 student_id' });
    }

    let currentSession = activeCourseSessions[course_id];
    if (!currentSession) {
        const sessionKeys = Object.keys(activeCourseSessions);
        if (sessionKeys.length > 0) currentSession = activeCourseSessions[sessionKeys[0]];
    }

    if (!currentSession) {
        return res.status(404).json({ success: false, message: '目前沒有任何進行中的課堂點名' });
    }

    const isEnrolled = !!currentSession.students[student_id];
    let myOtp = currentSession.students[student_id];

    if (!myOtp) {
        const fallbackOtp = Math.floor(100000 + Math.random() * 900000).toString();
        currentSession.students[student_id] = fallbackOtp;
        currentSession.studentRawList[student_id] = `未選課學生_${student_id}`;
        myOtp = fallbackOtp;
    }

    res.status(200).json({
        success: true,
        is_enrolled: isEnrolled,
        session_id: currentSession.session_id,
        otp: myOtp,
        xor_key: currentSession.xor_key,
        remaining_seconds: 9999
    });
});

// 老師結束點名
app.post('/api/session/stop', (req, res) => {
    const course_id = req.body.course_id ? parseInt(req.body.course_id) : 1;
    const { email, session_id } = req.body;

    const session = (session_id && activeSessionsById[session_id]) || activeCourseSessions[course_id] || (email ? activeSessions[email.toLowerCase().trim()] : null);
    if (!session) {
        return res.status(404).json({ success: false, message: '該課程目前未在點名中或已結束' });
    }

    const courseName = session.course_name;
    const currentSessionId = session.session_id;

    const sqlCourseStudents = 'SELECT COUNT(*) as total FROM course_students WHERE course_id = ?';
    const sqlAttended = 'SELECT COUNT(DISTINCT user_id) as attended FROM check_in WHERE course_id = ?';

    db.query(sqlCourseStudents, [course_id], (cErr, cTotal) => {
        db.query(sqlAttended, [course_id], (aErr, aAttended) => {
            const totalStudents = (cTotal && cTotal[0]) ? cTotal[0].total : 0;
            const attendedStudents = (aAttended && aAttended[0]) ? aAttended[0].attended : 0;

            delete activeCourseSessions[course_id];
            delete activeSessionsById[currentSessionId];
            if (email) delete activeSessions[email.toLowerCase().trim()];

            console.log(`🛑 [點名結束] 課程: ${courseName} (Session: ${currentSessionId}) 應到: ${totalStudents}, 實到: ${attendedStudents}`);

            res.status(200).json({
                success: true,
                message: '課堂點名已順利結束！',
                session_id: currentSessionId,
                course_id: course_id,
                course_name: courseName,
                total_students: totalStudents,
                attended_students: attendedStudents,
                absent_students: Math.max(0, totalStudents - attendedStudents)
            });
        });
    });
});

// 匯出 CSV 報表
app.get('/api/session/export-csv', (req, res) => {
    const course_id = req.query.course_id ? parseInt(req.query.course_id) : 1;

    db.query('SELECT course_name FROM courses WHERE id = ?', [course_id], (cErr, cResults) => {
        const courseName = (cResults && cResults.length > 0) ? cResults[0].course_name : '點名課程';
        const sqlStudents = 'SELECT student_id, student_name FROM course_students WHERE course_id = ?';

        db.query(sqlStudents, [course_id], (sErr, allStudents) => {
            if (sErr) return res.status(500).send('讀取名單失敗');

            const studentsList = (allStudents && allStudents.length > 0)
                ? allStudents
                : COURSE_ENROLLED_STUDENTS.map(s => ({ student_id: s.id, student_name: s.name }));

            const sqlCheckin = 'SELECT user_id, device_id, created_at FROM check_in WHERE course_id = ?';
            db.query(sqlCheckin, [course_id], (ckErr, checkinList) => {
                if (ckErr) return res.status(500).send('讀取打卡記錄失敗');

                let checkinMap = {};
                (checkinList || []).forEach(row => {
                    checkinMap[row.user_id.toString()] = {
                        device: row.device_id || '無',
                        time: row.created_at ? new Date(row.created_at).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' }) : '已簽到'
                    };
                });

                let csvContent = '\uFEFF'; 
                csvContent += '學號,姓名,課程名稱,出席狀態,簽到設備位址,簽到時間\n';

                studentsList.forEach(s => {
                    const studentId = s.student_id;
                    const studentName = s.student_name;
                    const record = checkinMap[studentId.toString()];
                    const status = record ? '已出席' : '缺席';
                    const device = record ? record.device : '-';
                    const checkinTime = record ? record.time : '-';

                    csvContent += `"${studentId}","${studentName}","${courseName}","${status}","${device}","${checkinTime}"\n`;
                });

                const fileName = `attendance_course_${course_id}_${Date.now()}.csv`;
                res.setHeader('Content-Type', 'text/csv; charset=utf-8');
                res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
                res.status(200).send(csvContent);
            });
        });
    });
});

// ==========================================
// 5. 定位系統專用 API
// ==========================================

app.post('/api/coords', (req, res) => {
    const { session_id, student_id, x, y, coordinate_system, timestamp } = req.body;

    if (!session_id || !student_id || x === undefined || y === undefined || !coordinate_system || !timestamp) {
        return res.status(400).json({ status: "failed", reason: "invalid_body", message: "缺少欄位" });
    }

    const session = activeSessionsById[session_id];
    if (!session) {
        return res.status(400).json({ status: "failed", reason: "invalid_coord", message: "session_id 不存在" });
    }

    const numX = parseFloat(x);
    const numY = parseFloat(y);
    if (coordinate_system === 'grid32') {
        if (isNaN(numX) || isNaN(numY) || numX < 0 || numX > 31 || numY < 0 || numY > 31) {
            return res.status(400).json({ status: "failed", reason: "invalid_coord", message: "座標超出 grid32 範圍" });
        }
    }

    if (!coordBuffer[session_id]) {
        coordBuffer[session_id] = { coordinateSystem: coordinate_system, updatedAt: timestamp, students: {} };
    }

    coordBuffer[session_id].coordinateSystem = coordinate_system;
    coordBuffer[session_id].updatedAt = timestamp;
    coordBuffer[session_id].students[student_id] = { x: numX, y: numY, timestamp: timestamp };

    return res.status(200).json({ status: "ok", accepted: true });
});

app.post('/api/coords/get', (req, res) => {
    const { email, password, session_id } = req.body;
    if (!email || !password || !session_id) {
        return res.status(400).json({ status: "failed", reason: "invalid_body", message: "缺少參數" });
    }

    const cleanEmail = email.toLowerCase().trim();
    db.query('SELECT * FROM user WHERE email = ? AND password = ?', [cleanEmail, password], (err, rows) => {
        if (err || !rows || rows.length === 0) {
            return res.status(401).json({ status: "failed", reason: "invalid_credentials", message: "帳號或密碼錯誤" });
        }

        const session = activeSessionsById[session_id];
        if (!session) {
            return res.status(404).json({ status: "failed", reason: "session_not_found", message: "查無此 session_id" });
        }

        if (session.teacher_email !== cleanEmail) {
            return res.status(403).json({ status: "failed", reason: "forbidden", message: "此 session 不屬於該老師" });
        }

        const buffer = coordBuffer[session_id] || { coordinateSystem: "grid32", students: {} };
        const studentCoords = buffer.students || {};

        return res.status(200).json({
            session_id: session_id,
            coordinate_system: buffer.coordinateSystem || "grid32",
            count: Object.keys(studentCoords).length,
            updated_at: buffer.updatedAt || new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' }),
            coords: studentCoords
        });
    });
});

app.post('/api/coords/clear', (req, res) => {
    const { email, password, session_id } = req.body;
    if (!email || !password || !session_id) {
        return res.status(400).json({ status: "failed", reason: "invalid_body", message: "缺少參數" });
    }

    const cleanEmail = email.toLowerCase().trim();
    db.query('SELECT * FROM user WHERE email = ? AND password = ?', [cleanEmail, password], (err, rows) => {
        if (err || !rows || rows.length === 0) {
            return res.status(401).json({ status: "failed", reason: "invalid_credentials", message: "帳號或密碼錯誤" });
        }

        let clearedCount = 0;
        if (coordBuffer[session_id]) {
            clearedCount = Object.keys(coordBuffer[session_id].students || {}).length;
            delete coordBuffer[session_id];
        }

        return res.status(200).json({ status: "ok", session_id: session_id, cleared: clearedCount });
    });
});

// 學生打卡入庫
app.post('/api/check-in', (req, res) => {
    const { student_info, device_address } = req.body;
    const course_id = req.body.course_id ? parseInt(req.body.course_id) : 1;

    if (!student_info) {
        return res.status(400).json({ success: false, message: '資料缺少 (student_info)' });
    }

    const sql = 'INSERT INTO check_in (user_id, device_id, course_id) VALUES (?, ?, ?)';
    db.query(sql, [student_info, device_address, course_id], (err) => {
        if (err) {
            logSystemError('打卡寫入資料庫失敗', err, req);
            return res.status(500).json({ success: false, message: 'Database Error', error: err });
        }
        console.log(`✅ [點名成功] 學生 ${student_info} 已簽到課程 ID: ${course_id}`);
        res.status(200).json({ success: true, message: 'Success' });
    });
});

// 查詢出席狀態表格
app.get('/api/session/attendance-status', (req, res) => {
    const course_id = req.query.course_id ? parseInt(req.query.course_id) : 1;
    const sqlCourseStudents = 'SELECT student_id, student_name FROM course_students WHERE course_id = ?';

    db.query(sqlCourseStudents, [course_id], (err, allStudents) => {
        const studentsList = (allStudents && allStudents.length > 0)
            ? allStudents.map(s => ({ id: s.student_id, name: s.student_name }))
            : COURSE_ENROLLED_STUDENTS;

        const sqlAttended = 'SELECT DISTINCT user_id FROM check_in WHERE course_id = ?';
        db.query(sqlAttended, [course_id], (aErr, attendedResults) => {
            if (aErr) return res.status(500).json([]);

            const attendedIds = new Set((attendedResults || []).map(r => r.user_id.toString()));
            const report = studentsList.map(s => ({
                id: s.id,
                name: s.name,
                course_name: "行動應用與物聯網專案實作",
                status: attendedIds.has(s.id.toString()) ? "✅ 已出席" : "❌ 缺席"
            }));

            res.json(report);
        });
    });
});

app.get('/api/users', (req, res) => {
    db.query('SELECT user_id, name, email, device_id, role, (password IS NOT NULL) AS is_registered FROM user', (err, results) => {
        if (err) logSystemError('查詢使用者清單失敗', err, req);
        res.json(results || []);
    });
});

// ==========================================
// 🚨 Express 全域未處理錯誤中介層
// ==========================================
app.use((err, req, res, next) => {
    logSystemError('Express 路由未攔截錯誤 (500)', err, req);
    res.status(500).json({
        success: false,
        message: '伺服器內部發生錯誤，已記錄至 error.log',
        detail: err.message
    });
});

app.listen(3000, '0.0.0.0', () => {
    console.log('===========================================================');
    console.log('🚀 藍牙防作弊點名系統 - 全功能整合版已啟動！');
    console.log('🌐 運行埠口: 3000');
    console.log('🔒 點名 OTP 模式: 全程固定靜態 OTP (已移除 30 秒自動更新)');
    console.log('🗓️ 課表雙向同步: 支援同名課程自動標註 1、2');
    console.log('👤 學生帳號: 匯入時預建帳號，密碼由學生親自註冊驗證後啟用');
    console.log('📁 錯誤日誌自動寫入: ' + ERROR_LOG_PATH);
    console.log('===========================================================');
});
