const express = require('express');
const mysql = require('mysql2');
const nodemailer = require('nodemailer');
const cors = require('cors');
const bodyParser = require('body-parser');
const crypto = require('crypto');
const http = require('http');

const app = express();
app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.text({ type: ['text/csv', 'text/plain'] }));

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

// 座標相關 API 的統一錯誤記錄（維持既有 console + emoji 風格，不新增依賴）
function logCoordFailure(tag, status, reason, extra) {
    console.log(`🚫 [${tag}失敗] ${status} ${reason}${extra ? ' | ' + extra : ''}`);
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
// 1. 資料庫連線與自動初始化
// ==========================================
const db = mysql.createConnection({
    host: 'localhost',
    user: 'root',
    password: 'knowledge',
    database: 'ble_mcu'
});

let activeCourseSessions = {}; 
let activeSessions = {};
let activeSessionsById = {};
let sessionIntervals = {};
let tempCodes = {};
let coordBuffer = {};

db.connect((err) => {
    if (err) {
        console.error('❌ 資料庫連線失敗:', err);
    } else {
        console.log('✅ 資料庫連線成功！');

        // 1. 確保 user 表結構包含 role 欄位
        const checkRoleColumnSql = `
            SELECT COUNT(*) AS count 
            FROM information_schema.COLUMNS 
            WHERE TABLE_SCHEMA = 'ble_mcu' 
              AND TABLE_NAME = 'user' 
              AND COLUMN_NAME = 'role';
        `;
        db.query(checkRoleColumnSql, (cErr, cResults) => {
            if (!cErr && cResults[0].count === 0) {
                db.query("ALTER TABLE user ADD COLUMN role VARCHAR(20) DEFAULT 'student';", (alterErr) => {
                    if (!alterErr) console.log('🛠️ [資料庫升級] 成功為 user 資料表新增 role 欄位！');
                });
            }
        });

        // 2. 建立課程總表 courses
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

        // 3. 建立並同步修課名單表 course_students
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

        // 4. 建立 App v6.1 專用課表與名單儲存表 teacher_schedules
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

        // 5. 初始化 7 位測試學生帳號 (密碼預設 123456，完全解除裝置限制)
        ALL_TEST_USERS.forEach(u => {
            const sqlInsertUser = `
                INSERT INTO user (user_id, name, password, email, device_id, role)
                VALUES (?, ?, '123456', ?, 'ANY_DEVICE', 'student')
                ON DUPLICATE KEY UPDATE device_id = 'ANY_DEVICE';
            `;
            db.query(sqlInsertUser, [u.id, u.name, u.email]);
        });
        console.log('🔓 [免綁定設定] 7 位學生帳號已全部確認可登入 (裝置限制已解除)！');

        // 6. 初始化教師帳號：
        // (A) 預設老師：有預設課程
        const initTeacherSql = `
            INSERT INTO user (user_id, name, password, email, device_id, role) 
            VALUES ('T001', '指導老師', 'teacher123', 'teacher@mail.mcu.edu.tw', 'ANY_DEVICE', 'teacher') 
            ON DUPLICATE KEY UPDATE name='指導老師', password='teacher123', email='teacher@mail.mcu.edu.tw', device_id='ANY_DEVICE', role='teacher';
        `;
        db.query(initTeacherSql, () => {
            console.log('👨‍🏫 [系統就緒] 預設老師帳號 (teacher@mail.mcu.edu.tw) 已確認就緒！');
        });

        // (B) 測試用全空白課表老師帳號：無預設排課，需先匯入課程
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
// 2. 帳號與登入接口 (完全解除裝置綁定)
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
        from: '"藍牙點名系統" <nhentai696@gmail.com>',
        to: email,
        subject: `【點名系統】${role === 'teacher' ? '教師' : '學生'}註冊驗證碼`,
        text: `您好！您的驗證碼是：${code}\n請於 5 分鐘內輸入此代碼以完成註冊。`
    };

    transporter.sendMail(mailOptions, (err) => {
        if (err) return res.status(500).json({ success: false, message: '寄信失敗' });
        res.status(200).json({ success: true, message: 'Sent', role });
    });
});

app.post('/api/register', (req, res) => {
    const { user_id, name, email, password, code } = req.body;
    const record = tempCodes[email];
    if (!record) return res.status(400).json({ success: false, message: '請先獲取驗證碼' });
    if (record.code !== code) return res.status(400).json({ success: false, message: '驗證碼錯誤' });
    if (Date.now() > record.expires) return res.status(400).json({ success: false, message: '驗證碼已過期' });

    const role = getRoleByEmail(email);
    const finalDeviceId = 'ANY_DEVICE'; // 免綁定裝置

    db.query('SELECT * FROM user WHERE user_id = ? OR email = ?', [user_id, email], (checkErr, checkResults) => {
        if (checkErr) return res.status(500).json({ success: false, message: '資料庫檢查錯誤' });
        if (checkResults && checkResults.length > 0) {
            return res.status(400).json({ success: false, message: '此帳號或信箱已註冊過！' });
        }

        const sql = `INSERT INTO user (user_id, name, password, email, device_id, role) VALUES (?, ?, ?, ?, ?, ?)`;
        db.query(sql, [user_id, name, password, email, finalDeviceId, role], (err) => {
            if (err) return res.status(500).json({ success: false, message: '資料庫錯誤' });
            delete tempCodes[email];
            console.log(`👤 [新用戶註冊] 工號/學號: ${user_id} 註冊成功 (免綁定裝置)！`);
            res.status(200).json({ success: true, status: 'success', message: 'Success', role: role });
        });
    });
});

app.post('/api/auth/login', (req, res) => {
    const { email, password } = req.body;

    if (!email || !password) {
        return res.status(400).json({ success: false, message: '請填寫信箱與密碼' });
    }

    const cleanEmail = email.toLowerCase().trim();
    const inferredRole = getRoleByEmail(cleanEmail);

    const sql = 'SELECT * FROM user WHERE email = ? AND password = ?';
    db.query(sql, [cleanEmail, password], (err, results) => {
        if (err) return res.status(500).json({ success: false, message: '資料庫錯誤' });
        if (!results || results.length === 0) {
            console.log(`❌ [登入失敗] 信箱或密碼錯誤: ${cleanEmail}`);
            return res.status(401).json({ success: false, message: '信箱或密碼錯誤' });
        }

        const user = results[0];
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

        // 學生裝置檢查完全關閉，任意設備均可直接登入
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
// 3. 課表雙向同步 API (App v6.1 專用端點)
// ==========================================

// (1) 課表同步端點：老師匯入課程後將課表與名單更新進資料庫
app.post('/api/teacher/schedule/sync', (req, res) => {
    const { email, schedule, students } = req.body;

    if (!email) {
        return res.status(400).json({ success: false, message: '缺少老師信箱 (email)' });
    }

    const cleanEmail = email.toLowerCase().trim();
    // 確保儲存時為字串化之 JSON
    const scheduleStr = typeof schedule === 'object' ? JSON.stringify(schedule) : (schedule || "");
    const studentsStr = typeof students === 'object' ? JSON.stringify(students) : (students || "");

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
            console.error('❌ [課表同步失敗]:', err);
            return res.status(500).json({ success: false, message: '資料庫寫入課表失敗' });
        }

        console.log(`📥 [課表與名單同步成功] 老師: ${cleanEmail} 最新課表與名單已成功更新至資料庫！`);
        return res.status(200).json({
            success: true,
            message: '課表與名單同步成功'
        });
    });
});

// (2) 課表拉取端點：老師登入後自伺服器拉取最新課表與名單
app.post('/api/teacher/schedule/get', (req, res) => {
    const { email } = req.body;

    if (!email) {
        return res.status(400).json({ success: false, message: '請提供 email' });
    }

    const cleanEmail = email.toLowerCase().trim();
    const sqlQuery = 'SELECT schedule_data, students_data FROM teacher_schedules WHERE teacher_email = ?';

    db.query(sqlQuery, [cleanEmail], (err, rows) => {
        if (err) {
            console.error('❌ [查詢課表錯誤]:', err);
            return res.status(500).json({ success: false, message: '伺服器查詢錯誤' });
        }

        // 若該老師已有儲存課表
        if (rows && rows.length > 0 && rows[0].schedule_data) {
            console.log(`📤 [課表拉取成功] 老師: ${cleanEmail} 已順利取得雲端課表與名單`);
            return res.status(200).json({
                success: true,
                schedule: rows[0].schedule_data,
                students: rows[0].students_data || ""
            });
        }

        // 若為新老師（如 newteacher@mail.mcu.edu.tw），回傳空白課表
        console.log(`ℹ️ [無排課紀錄] 老師: ${cleanEmail} 目前無雲端課表，回傳全空白課表`);
        return res.status(200).json({
            success: true,
            schedule: "",
            students: ""
        });
    });
});

// ==========================================
// 4. 動態點名 Session 接口 (整合 30 秒換碼與日誌)
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

function refreshCourseOtps(course_id) {
    const session = activeCourseSessions[course_id];
    if (!session) return;

    session.previousStudents = { ...(session.students || {}) };
    const studentIds = Object.keys(session.studentRawList || {});
    let newOtpMap = {};

    studentIds.forEach(id => {
        newOtpMap[id] = Math.floor(100000 + Math.random() * 900000).toString();
    });

    session.students = newOtpMap;
    session.updated_at = Date.now();

    console.log('\n-----------------------------------------------------------');
    console.log(`🔄 [Rolling OTP 更新] 課程: ${session.course_name} (ID: ${course_id})`);
    console.log(`🔑 本堂課共用 XOR Key : ${session.xor_key}`);
    console.log(`📋 最新 30 秒動態 OTP 表 (時效 30s) :`);
    Object.keys(newOtpMap).forEach(sid => {
        console.log(`   👉 學號: ${sid} (${session.studentRawList[sid] || '學生'}) -> OTP: ${newOtpMap[sid]}`);
    });
    console.log('-----------------------------------------------------------');

    notifyPositioningServer({
        session_id: session.session_id,
        xor_key: session.xor_key,
        otp_list: newOtpMap,
        timeout: 5
    });
}

// 老師開始點名 Session
app.post('/api/session/start', (req, res) => {
    const { email, password } = req.body;
    const course_id = req.body.course_id ? parseInt(req.body.course_id) : 1;

    if (!email) {
        return res.status(400).json({ success: false, message: '請提供 email' });
    }

    const proceedStart = () => {
        if (sessionIntervals[course_id]) {
            clearInterval(sessionIntervals[course_id]);
            delete sessionIntervals[course_id];
        }

        const sqlCourse = 'SELECT * FROM courses WHERE id = ?';
        db.query(sqlCourse, [course_id], (cErr, courseResults) => {
            const courseName = (courseResults && courseResults.length > 0) ? courseResults[0].course_name : "行動應用與物聯網專案實作";
            const courseCode = (courseResults && courseResults.length > 0) ? courseResults[0].course_code : "MCU_BLE_PROJECT";

            const sqlStudents = 'SELECT student_id, student_name FROM course_students WHERE course_id = ?';
            db.query(sqlStudents, [course_id], (sErr, studentResults) => {
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
                    previousStudents: {},
                    studentRawList: studentRawList,
                    started_at: Date.now(),
                    updated_at: Date.now()
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
                console.log(`🔑 本次 Session ID: ${sessionId}`);
                console.log(`🔑 本堂課共用 XOR Key : ${xorKey}`);
                console.log(`👥 本次課堂修課學生共 ${studentsToUse.length} 人：`);
                Object.keys(studentOtpMap).forEach(sid => {
                    console.log(`   👉 學號: ${sid} (${studentRawList[sid] || '學生'}) -> 初始 OTP: ${studentOtpMap[sid]}`);
                });
                console.log(`⏱️ 30 秒自動換碼機制已啟動！`);
                console.log('===========================================================');

                notifyPositioningServer({
                    session_id: sessionId,
                    xor_key: xorKey,
                    otp_list: studentOtpMap,
                    timeout: 5
                });

                sessionIntervals[course_id] = setInterval(() => {
                    refreshCourseOtps(course_id);
                }, 30000);

                res.status(200).json({
                    success: true,
                    status: "success",
                    course_id: course_id,
                    course_name: courseName,
                    session_id: sessionId,
                    xor_key: xorKey,
                    otp_interval_seconds: 30
                });
            });
        });
    };

    if (password) {
        db.query('SELECT * FROM user WHERE email = ? AND password = ?', [email.toLowerCase().trim(), password], (err, rows) => {
            if (err || !rows || rows.length === 0) {
                return res.status(401).json({ status: 'failed', reason: 'invalid_credentials', message: '帳號或密碼錯誤' });
            }
            proceedStart();
        });
    } else {
        proceedStart();
    }
});

// 老師端查詢 OTP 名單
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

    const elapsed = Math.floor((Date.now() - session.updated_at) / 1000);
    const remainingSeconds = Math.max(0, 30 - (elapsed % 30));

    res.status(200).json({
        success: true,
        session_id: session.session_id,
        course_name: session.course_name,
        xor_key: session.xor_key,
        otp_list: session.students,
        remaining_seconds: remainingSeconds
    });
});

// 學生端獲取點名權杖
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
        // 未修課學生測試防作弊
        const fallbackOtp = Math.floor(100000 + Math.random() * 900000).toString();
        currentSession.students[student_id] = fallbackOtp;
        currentSession.studentRawList[student_id] = `未選課學生_${student_id}`;
        myOtp = fallbackOtp;
        console.log(`⚠️ [非修課學生取權杖] 學號: ${student_id} (不在名單內) 動態獲得 OTP: ${myOtp}`);
    } else {
        console.log(`📱 [修課學生取權杖] 學號: ${student_id} (名單內) 取得 OTP: ${myOtp} | XOR Key: ${currentSession.xor_key}`);
    }

    const elapsed = Math.floor((Date.now() - currentSession.updated_at) / 1000);
    const remainingSeconds = Math.max(0, 30 - (elapsed % 30));

    res.status(200).json({
        success: true,
        is_enrolled: isEnrolled,
        session_id: currentSession.session_id,
        otp: myOtp,
        xor_key: currentSession.xor_key,
        remaining_seconds: remainingSeconds
    });
});

// 老師結束點名
app.post('/api/session/stop', (req, res) => {
    const course_id = req.body.course_id ? parseInt(req.body.course_id) : 1;
    const { email, session_id } = req.body;

    if (sessionIntervals[course_id]) {
        clearInterval(sessionIntervals[course_id]);
        delete sessionIntervals[course_id];
    }

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

            console.log(`🛑 [點名已結束] 課程: ${courseName} (Session: ${currentSessionId})`);
            console.log(`📊 應到: ${totalStudents} 人，實到: ${attendedStudents} 人`);

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
    const { session_id, student_id, x, y, coordinate_system, timestamp } = req.body || {};

    if (!session_id || !student_id || x === undefined || y === undefined || !coordinate_system || !timestamp) {
        logCoordFailure('座標上報', 400, 'invalid_body', `session: ${session_id || '-'} | 學生: ${student_id || '-'} | 缺欄位`);
        return res.status(400).json({ status: "failed", reason: "invalid_body", message: "缺少欄位" });
    }

    const session = activeSessionsById[session_id];
    if (!session) {
        logCoordFailure('座標上報', 400, 'invalid_coord', `session_id 不存在 (${session_id}) | 學生: ${student_id}`);
        return res.status(400).json({ status: "failed", reason: "invalid_coord", message: "session_id 不存在" });
    }

    // 只接受本次點名名單內的學生（get-token 會把未選課學生動態加入 studentRawList）
    const isKnownStudent = !!(session.studentRawList && session.studentRawList[student_id]);
    if (!isKnownStudent) {
        logCoordFailure('座標上報', 400, 'invalid_coord', `學生 ${student_id} 不在 session ${session_id} 的名單內`);
        return res.status(400).json({ status: "failed", reason: "invalid_coord", message: "student_id 不屬於本堂課" });
    }

    const numX = parseFloat(x);
    const numY = parseFloat(y);
    if (coordinate_system === 'grid32') {
        if (isNaN(numX) || isNaN(numY) || numX < 0 || numX > 31 || numY < 0 || numY > 31) {
            logCoordFailure('座標上報', 400, 'invalid_coord', `學生: ${student_id} -> (${x}, ${y}) 超出 grid32 範圍`);
            return res.status(400).json({ status: "failed", reason: "invalid_coord", message: "座標超出 grid32 範圍" });
        }
    }

    // 學生送來的 timestamp 只接受字串或數字，避免任意物件污染 buffer
    if (typeof timestamp !== 'string' && typeof timestamp !== 'number') {
        logCoordFailure('座標上報', 400, 'invalid_body', `學生: ${student_id} timestamp 型別不合法 (${typeof timestamp})`);
        return res.status(400).json({ status: "failed", reason: "invalid_body", message: "timestamp 格式錯誤" });
    }

    if (!coordBuffer[session_id]) {
        coordBuffer[session_id] = { coordinateSystem: coordinate_system, updatedAt: timestamp, students: {} };
    }

    coordBuffer[session_id].coordinateSystem = coordinate_system;
    coordBuffer[session_id].updatedAt = timestamp;
    coordBuffer[session_id].students[student_id] = { x: numX, y: numY, timestamp: timestamp };

    console.log(`📍 [收到座標] Session: ${session_id} | 學生: ${student_id} -> (${numX}, ${numY}) [${coordinate_system}]`);
    return res.status(200).json({ status: "ok", accepted: true });
});

app.post('/api/coords/get', (req, res) => {
    const { email, password, session_id } = req.body || {};
    if (!email || !password || !session_id) {
        logCoordFailure('座標查詢', 400, 'invalid_body', `session: ${session_id || '-'} | email: ${email || '-'} | 缺參數`);
        return res.status(400).json({ status: "failed", reason: "invalid_body", message: "缺少參數" });
    }

    const cleanEmail = email.toLowerCase().trim();
    db.query('SELECT user_id, email, role FROM user WHERE email = ? AND password = ?', [cleanEmail, password], (err, rows) => {
        if (err) {
            logCoordFailure('座標查詢', 500, 'db_error', `email: ${cleanEmail} | ${err.message}`);
            return res.status(500).json({ status: "failed", reason: "db_error", message: "資料庫錯誤" });
        }
        if (!rows || rows.length === 0) {
            logCoordFailure('座標查詢', 401, 'invalid_credentials', `email: ${cleanEmail} | session: ${session_id}`);
            return res.status(401).json({ status: "failed", reason: "invalid_credentials", message: "帳號或密碼錯誤" });
        }

        // 座標屬於教學資料，僅開放教師帳號拉取
        if (rows[0].role !== 'teacher') {
            logCoordFailure('座標查詢', 403, 'forbidden', `非教師帳號 (role: ${rows[0].role}) 嘗試拉取 | email: ${cleanEmail}`);
            return res.status(403).json({ status: "failed", reason: "forbidden", message: "僅限教師帳號查詢座標" });
        }

        const session = activeSessionsById[session_id];
        if (!session) {
            logCoordFailure('座標查詢', 404, 'session_not_found', `email: ${cleanEmail} | session: ${session_id}`);
            return res.status(404).json({ status: "failed", reason: "session_not_found", message: "查無此 session_id" });
        }

        if (session.teacher_email !== cleanEmail) {
            logCoordFailure('座標查詢', 403, 'forbidden', `要求者: ${cleanEmail} | session 擁有者: ${session.teacher_email}`);
            return res.status(403).json({ status: "failed", reason: "forbidden", message: "此 session 不屬於該老師" });
        }

        const buffer = coordBuffer[session_id] || { coordinateSystem: "grid32", students: {} };
        const studentCoords = buffer.students || {};
        const coordCount = Object.keys(studentCoords).length;

        console.log(`🗺️ [座標查詢成功] 老師: ${cleanEmail} | Session: ${session_id} | 回傳 ${coordCount} 筆座標`);

        return res.status(200).json({
            session_id: session_id,
            coordinate_system: buffer.coordinateSystem || "grid32",
            count: coordCount,
            updated_at: buffer.updatedAt || new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' }),
            coords: studentCoords
        });
    });
});

app.post('/api/coords/clear', (req, res) => {
    const { email, password, session_id } = req.body || {};
    if (!email || !password || !session_id) {
        logCoordFailure('清除座標', 400, 'invalid_body', `session: ${session_id || '-'} | email: ${email || '-'} | 缺參數`);
        return res.status(400).json({ status: "failed", reason: "invalid_body", message: "缺少參數" });
    }

    const cleanEmail = email.toLowerCase().trim();
    db.query('SELECT user_id, email, role FROM user WHERE email = ? AND password = ?', [cleanEmail, password], (err, rows) => {
        if (err) {
            logCoordFailure('清除座標', 500, 'db_error', `email: ${cleanEmail} | ${err.message}`);
            return res.status(500).json({ status: "failed", reason: "db_error", message: "資料庫錯誤" });
        }
        if (!rows || rows.length === 0) {
            logCoordFailure('清除座標', 401, 'invalid_credentials', `email: ${cleanEmail} | session: ${session_id}`);
            return res.status(401).json({ status: "failed", reason: "invalid_credentials", message: "帳號或密碼錯誤" });
        }

        // 與 /api/coords/get 對齊：僅教師、且僅該 session 的擁有者可清除座標
        if (rows[0].role !== 'teacher') {
            logCoordFailure('清除座標', 403, 'forbidden', `非教師帳號 (role: ${rows[0].role}) 嘗試清除 | email: ${cleanEmail}`);
            return res.status(403).json({ status: "failed", reason: "forbidden", message: "僅限教師帳號清除座標" });
        }

        const session = activeSessionsById[session_id];
        if (!session) {
            logCoordFailure('清除座標', 404, 'session_not_found', `email: ${cleanEmail} | session: ${session_id}`);
            return res.status(404).json({ status: "failed", reason: "session_not_found", message: "查無此 session_id" });
        }

        if (session.teacher_email !== cleanEmail) {
            logCoordFailure('清除座標', 403, 'forbidden', `要求者: ${cleanEmail} | session 擁有者: ${session.teacher_email}`);
            return res.status(403).json({ status: "failed", reason: "forbidden", message: "此 session 不屬於該老師" });
        }

        let clearedCount = 0;
        if (coordBuffer[session_id]) {
            clearedCount = Object.keys(coordBuffer[session_id].students || {}).length;
            delete coordBuffer[session_id];
        }

        console.log(`🧹 [清除座標] Session: ${session_id} 已清除 (${clearedCount} 筆座標) | 操作者: ${cleanEmail}`);
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
        if (err) return res.status(500).json({ success: false, message: 'Database Error', error: err });
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
    db.query('SELECT user_id, name, email, device_id, role FROM user', (err, results) => {
        res.json(results);
    });
});

app.listen(3000, '0.0.0.0', () => {
    console.log('===========================================================');
    console.log('🚀 藍牙防作弊點名系統 - 後端伺服器 (支援 App v6.1 課表同步版) 已啟動！');
    console.log('🌐 運行埠口: 3000');
    console.log('🗓️ 支援課表雙向同步: /api/teacher/schedule/sync & /api/teacher/schedule/get');
    console.log('🔓 學生裝置限制: 已完全解除 (任何裝置皆可登入)');
    console.log('👥 預設修課名單: 5 位組員 (0305, 0615, 0596, 0651, 3033)');
    console.log('👨‍🏫 全空白課表測試老師: newteacher@mail.mcu.edu.tw (密碼: teacher123)');
    console.log('===========================================================');
});
