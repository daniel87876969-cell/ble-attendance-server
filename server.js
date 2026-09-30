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

// 產生不可預測的隨機 16 碼 session_id (例如 9f3c1a7e4b2d4c8f)
function generateSecureSessionId() {
    return crypto.randomBytes(8).toString('hex');
}

// 預設 5 人固定模擬課程名單 (用於自動初始化資料庫與向下相容)
const DEFAULT_STUDENTS = [
    { id: "12360305", name: "組員A" },
    { id: "12360615", name: "組員B" },
    { id: "12360333", name: "組員C" },
    { id: "12360342", name: "組員D" },
    { id: "12360596", name: "組員E" }
];

// ==========================================
// 1. 設定區域 (資料庫、Session、座標暫存 Buffer)
// ==========================================
const db = mysql.createConnection({
    host: 'localhost',
    user: 'root',
    password: 'knowledge',
    database: 'ble_mcu'
});

// 以 course_id, email, session_id 為索引的動態點名 Sessions
let activeCourseSessions = {}; 
let activeSessions = {}; // email 索引
let activeSessionsById = {}; // session_id 索引
let sessionIntervals = {}; // 管理每門課 30 秒更新的 Timer
let tempCodes = {};

// 座標暫存 Buffer (In-memory，依據規格 §2.3)
let coordBuffer = {};

// 資料庫連線並自動建立與初始化資料表
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

                // 自動插入預設課程 1 (若不存在)
                const checkDefaultCourseSql = 'SELECT * FROM courses WHERE id = 1';
                db.query(checkDefaultCourseSql, (cdErr, cdRes) => {
                    if (!cdErr && cdRes.length === 0) {
                        const initCourseSql = `
                            INSERT INTO courses (id, course_code, course_name, teacher_id)
                            VALUES (1, 'MCU_BLE_PROJECT', '行動應用與物聯網專案實作', 'teacher@mail.mcu.edu.tw');
                        `;
                        db.query(initCourseSql, (icErr) => {
                            if (!icErr) console.log('🎯 [預設課程初始化] 已建立預設課程 1: 行動應用與物聯網專案實作');
                        });
                    }
                });
            }
        });

        // 3. 建立修課名單表 course_students
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

                // 自動將 5 位組員名單寫入課程 1 (若名單為空)
                const checkStudentsSql = 'SELECT COUNT(*) as cnt FROM course_students WHERE course_id = 1';
                db.query(checkStudentsSql, (csErr, csRes) => {
                    if (!csErr && csRes[0].cnt === 0) {
                        const studentValues = DEFAULT_STUDENTS.map(s => [1, s.id, s.name]);
                        const insertDefStudentsSql = 'INSERT IGNORE INTO course_students (course_id, student_id, student_name) VALUES ?';
                        db.query(insertDefStudentsSql, [studentValues], (isErr) => {
                            if (!isErr) console.log('👥 [預設學生名單] 已成功匯入 5 位預設組員至課程 1！');
                        });
                    }
                });
            }
        });

        // 4. 確保 check_in 表具有 created_at 欄位 (紀錄精準點名時間)
        const checkCheckinTimeSql = `
            SELECT COUNT(*) AS count 
            FROM information_schema.COLUMNS 
            WHERE TABLE_SCHEMA = 'ble_mcu' 
              AND TABLE_NAME = 'check_in' 
              AND COLUMN_NAME = 'created_at';
        `;
        db.query(checkCheckinTimeSql, (chkErr, chkRes) => {
            if (!chkErr && chkRes && chkRes[0].count === 0) {
                db.query("ALTER TABLE check_in ADD COLUMN created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;", (altErr) => {
                    if (!altErr) console.log('⏰ [資料庫升級] check_in 表已補齊 created_at 打卡時間欄位！');
                });
            }
        });

        // 5. 確保預設老師帳號存在
        const initTeacherSql = `
            INSERT INTO user (user_id, name, password, email, device_id, role) 
            VALUES ('T001', '指導老師', 'teacher123', 'teacher@mail.mcu.edu.tw', 'ANY_DEVICE', 'teacher') 
            ON DUPLICATE KEY UPDATE name='指導老師', password='teacher123', email='teacher@mail.mcu.edu.tw', device_id='ANY_DEVICE', role='teacher';
        `;
        db.query(initTeacherSql, (tErr) => {
            if (!tErr) {
                console.log('👨‍🏫 [系統就緒] 預設老師帳號 (teacher@mail.mcu.edu.tw) 已確認就緒！');
            }
        });
    }
});

const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: 'nhentai696@gmail.com',
        pass: 'ywikezgwjnasegke'
    }
});

// ==========================================
// 2. 帳號與登入接口
// ==========================================

// 發送註冊驗證碼
app.post('/api/send-code', (req, res) => {
    const { email } = req.body;

    if (
        !email || (
            !email.endsWith('@me.mcu.edu.tw') &&
            !email.endsWith('@mail.mcu.edu.tw')
        )
    ) {
        return res.status(403).json({ 
            success: false, 
            message: '限用學校信箱 (學生: @me.mcu.edu.tw / 教師: @mail.mcu.edu.tw)' 
        });
    }

    const role = getRoleByEmail(email);
    const code = Math.floor(100000 + Math.random() * 900000).toString(); 
    tempCodes[email] = { code, expires: Date.now() + 300000, role }; 

    const mailOptions = {
        from: '"藍牙點名系統" <nhentai696@gmail.com>',
        to: email,
        subject: `【點名系統】${role === 'teacher' ? '教師' : '學生'}註冊驗證碼`,
        text: `您好！您的驗證碼是：${code}\n請於 5 分鐘內輸入此代碼以完成${role === 'teacher' ? '教師帳號' : '學生帳號'}註冊。\n(若非本人操作請忽略)`
    };

    transporter.sendMail(mailOptions, (err) => {
        if (err) {
            console.error('寄信失敗:', err);
            return res.status(500).json({ success: false, message: '寄信失敗' });
        }
        console.log(`📩 [驗證碼發送] 身分: [${role}] 成功寄送給 ${email}，驗證碼為: ${code}`); 
        res.status(200).json({ success: true, message: 'Sent', role });
    });
});

// 註冊接口
app.post('/api/register', (req, res) => {
    const { user_id, name, email, password, code, device_id } = req.body;

    const record = tempCodes[email];
    if (!record) return res.status(400).json({ success: false, message: '請先獲取驗證碼' });
    if (record.code !== code) return res.status(400).json({ success: false, message: '驗證碼錯誤' });
    if (Date.now() > record.expires) return res.status(400).json({ success: false, message: '驗證碼已過期' });

    const role = getRoleByEmail(email);
    const finalDeviceId = (role === 'teacher') ? 'ANY_DEVICE' : (device_id || 'UNKNOWN');

    db.query('SELECT * FROM user WHERE user_id = ? OR email = ?', [user_id, email], (checkErr, checkResults) => {
        if (checkErr) return res.status(500).json({ success: false, message: '資料庫檢查錯誤' });
        
        if (checkResults && checkResults.length > 0) {
            return res.status(400).json({ success: false, message: '此帳號或信箱已註冊過，無法重複註冊！' });
        }

        const sql = `INSERT INTO user (user_id, name, password, email, device_id, role) VALUES (?, ?, ?, ?, ?, ?)`;
        db.query(sql, [user_id, name, password, email, finalDeviceId, role], (err) => {
            if (err) {
                console.error('註冊寫入資料庫失敗:', err);
                return res.status(500).json({ success: false, message: '資料庫錯誤' });
            }
            delete tempCodes[email];
            console.log(`👤 [新用戶註冊] 身分: [${role}] 工號/學號: ${user_id} 註冊成功！`);
            res.status(200).json({ success: true, status: 'success', message: 'Success', role: role });
        });
    });
});

// 登入接口
app.post('/api/auth/login', (req, res) => {
    const { email, password, device_id } = req.body;

    if (!email || !password) {
        return res.status(400).json({ success: false, message: '請填寫信箱與密碼' });
    }

    const cleanEmail = email.toLowerCase().trim();
    const inferredRole = getRoleByEmail(cleanEmail);

    console.log(`\n🔍 [收到登入請求] Email: ${cleanEmail} | 傳入DeviceID: ${device_id || '無'}`);

    const sql = 'SELECT * FROM user WHERE email = ? AND password = ?';
    db.query(sql, [cleanEmail, password], (err, results) => {
        if (err) {
            console.error('資料庫查詢錯誤:', err);
            return res.status(500).json({ success: false, message: '資料庫錯誤' });
        }

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

            console.log(`👨‍🏫 [教師登入成功] ${cleanEmail} (免綁定裝置)`);
            return res.status(200).json({
                success: true,
                status: 'success',
                message: 'Success',
                role: 'teacher',
                token: 'mock_token_' + user.user_id,
                user: {
                    user_id: user.user_id,
                    name: user.name,
                    email: user.email,
                    role: 'teacher'
                }
            });
        }

        if (user.device_id && user.device_id !== 'ANY_DEVICE' && user.device_id !== device_id) {
            console.log(`❌ [學生登入失敗] 裝置不相符 (資料庫: ${user.device_id}, 請求: ${device_id})`);
            return res.status(401).json({ success: false, message: '裝置未綁定或更換了手機' });
        }

        console.log(`🎓 [學生登入成功] ${cleanEmail}`);
        return res.status(200).json({
            success: true,
            status: 'success',
            message: 'Success',
            role: 'student',
            token: 'mock_token_' + user.user_id,
            user: {
                user_id: user.user_id,
                name: user.name,
                email: user.email,
                role: 'student'
            }
        });
    });
});

// ==========================================
// 3. 課程管理與 CSV 匯入接口
// ==========================================

app.get('/api/courses', (req, res) => {
    const teacherId = req.query.teacher_id || req.query.email;
    const sql = teacherId ? 'SELECT * FROM courses WHERE teacher_id = ? ORDER BY id DESC' : 'SELECT * FROM courses ORDER BY id DESC';
    db.query(sql, teacherId ? [teacherId] : [], (err, results) => {
        if (err) return res.status(500).json({ success: false, message: '資料庫查詢失敗' });
        res.status(200).json({ success: true, courses: results });
    });
});

app.post('/api/courses/import-csv', (req, res) => {
    let teacher_id = req.query.teacher_id || (req.body && req.body.teacher_id) || 'teacher@mail.mcu.edu.tw';
    let course_name = req.query.course_name || (req.body && req.body.course_name);
    let course_code = req.query.course_code || (req.body && req.body.course_code) || 'COURSE_' + Date.now();
    let students = [];

    if (typeof req.body === 'object' && Array.isArray(req.body.students)) {
        students = req.body.students;
    } else if (typeof req.body === 'string') {
        const lines = req.body.split(/\r?\n/).map(l => l.trim()).filter(l => l.length > 0);
        lines.forEach((line, index) => {
            if (index === 0 && (line.includes('學號') || line.toLowerCase().includes('id'))) return;
            const parts = line.split(',').map(item => item.trim());
            if (parts.length >= 1 && parts[0]) {
                students.push({
                    student_id: parts[0],
                    student_name: parts[1] || `學生_${parts[0]}`
                });
            }
        });
    }

    if (!course_name) {
        return res.status(400).json({ success: false, message: '缺少 course_name (課程名稱)' });
    }

    if (students.length === 0) {
        return res.status(400).json({ success: false, message: 'CSV 內未解析出任何學生名單' });
    }

    const insertCourseSql = 'INSERT INTO courses (course_code, course_name, teacher_id) VALUES (?, ?, ?)';
    db.query(insertCourseSql, [course_code, course_name, teacher_id], (cErr, cResult) => {
        if (cErr) {
            console.error('建立課程失敗:', cErr);
            return res.status(500).json({ success: false, message: '建立課程失敗' });
        }

        const newCourseId = cResult.insertId;
        const studentValues = students.map(s => [newCourseId, s.student_id || s.id, s.student_name || s.name || '']);
        const insertStudentsSql = 'INSERT IGNORE INTO course_students (course_id, student_id, student_name) VALUES ?';

        db.query(insertStudentsSql, [studentValues], (sErr) => {
            if (sErr) {
                console.error('匯入學生名單失敗:', sErr);
                return res.status(500).json({ success: false, message: '匯入學生失敗' });
            }

            console.log(`📥 [課表匯入成功] 老師: ${teacher_id} 新增課程: ${course_name} (ID: ${newCourseId})，共 ${students.length} 位學生`);
            res.status(200).json({
                success: true,
                message: '課表與名單匯入成功',
                course_id: newCourseId,
                total_students: students.length
            });
        });
    });
});

// ==========================================
// 4. 動態點名 Session 接口 (含定位串接與詳細日誌輸出)
// ==========================================

// 輔助函式：發送 HTTP POST 給定位計算程式 (Python http://127.0.0.1:8020/api/session/config)
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
        res.on('end', () => {
            console.log(`📡 [定位伺服器回應] 狀態碼: ${res.statusCode} | 內容: ${resBody}`);
        });
    });

    req.on('error', (e) => {
        console.log(`ℹ️ [定位伺服器通知] 本機 8020 端口未啟用 (${e.message})，不影響基礎簽到。`);
    });

    req.on('timeout', () => {
        req.destroy();
        console.log('⚠️ [定位伺服器通知] 連線至 127.0.0.1:8020 逾時');
    });

    req.write(postData);
    req.end();
}

// 輔助函式：為指定課程更新所有學生的動態 OTP (時效 30 秒) 並印出終端機日誌
function refreshCourseOtps(course_id) {
    const session = activeCourseSessions[course_id];
    if (!session) return;

    // 將現有的 OTP 留存為 previousStudents（寬限 30 秒，避免網路延遲）
    session.previousStudents = { ...(session.students || {}) };

    // 重新為所有已註冊學生產生新一輪 6 位數隨機碼
    const studentIds = Object.keys(session.studentRawList || {});
    let newOtpMap = {};

    studentIds.forEach(id => {
        newOtpMap[id] = Math.floor(100000 + Math.random() * 900000).toString();
    });

    session.students = newOtpMap;
    session.updated_at = Date.now(); // 記錄本輪更新時間點

    // 🎯 核心修改：在終端機完整印出 XOR Key 與全體學生的全新 OTP
    console.log('\n-----------------------------------------------------------');
    console.log(`🔄 [Rolling OTP 更新] 課程: ${session.course_name} (ID: ${course_id})`);
    console.log(`🔑 本堂課共用 XOR Key : ${session.xor_key}`);
    console.log(`📋 最新 30 秒動態 OTP 表 (時效 30s) :`);
    Object.keys(newOtpMap).forEach(sid => {
        console.log(`   👉 學號: ${sid} (${session.studentRawList[sid] || '學生'}) -> OTP: ${newOtpMap[sid]}`);
    });
    console.log('-----------------------------------------------------------');

    // 同步更新給定位計算程式
    notifyPositioningServer({
        session_id: session.session_id,
        xor_key: session.xor_key,
        otp_list: newOtpMap,
        timeout: 5
    });
}

// 老師啟動點名 (啟動 30 秒定時輪替定時器 + 初始化定位 Session)
app.post('/api/session/start', (req, res) => {
    const { email, password } = req.body;
    const course_id = req.body.course_id ? parseInt(req.body.course_id) : 1;

    if (!email) {
        return res.status(400).json({ success: false, message: '請提供 email' });
    }

    const proceedStart = () => {
        // 先清除既有的定時器 (若之前有未關閉的 Session)
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
                const sessionId = generateSecureSessionId(); // 🎯 不可預測隨機 16 碼 session_id
                let studentOtpMap = {};
                let studentRawList = {};

                const studentsToUse = (studentResults && studentResults.length > 0) 
                    ? studentResults 
                    : DEFAULT_STUDENTS.map(s => ({ student_id: s.id, student_name: s.name }));

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
                    previousStudents: {}, // 上一輪備用
                    studentRawList: studentRawList,
                    started_at: Date.now(),
                    updated_at: Date.now()
                };

                activeCourseSessions[course_id] = sessionData;
                activeSessions[cleanEmail] = sessionData;
                activeSessionsById[sessionId] = sessionData;

                // 🎯 依規格清空並建立該 session_id 的座標暫存 Buffer
                coordBuffer[sessionId] = {
                    coordinateSystem: "grid32",
                    updatedAt: new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' }),
                    students: {}
                };

                // 🎯 啟動時在終端機完整印出初始金鑰與名單 OTP
                console.log('\n===========================================================');
                console.log(`📢 [老師點名啟動] 課程: ${courseName} (ID: ${course_id})`);
                console.log(`🔑 本次 Session ID: ${sessionId}`);
                console.log(`🔑 本堂課共用 XOR Key : ${xorKey}`);
                console.log(`👥 已為 ${studentsToUse.length} 位學生生成初始專屬 OTP 表：`);
                Object.keys(studentOtpMap).forEach(sid => {
                    console.log(`   👉 學號: ${sid} (${studentRawList[sid] || '學生'}) -> 初始 OTP: ${studentOtpMap[sid]}`);
                });
                console.log(`⏱️ 30 秒自動換碼機制 (Rolling OTP) 已啟動！`);
                console.log('===========================================================');

                // 🎯 依規格 POST /api/session/config 通知同機 127.0.0.1:8020 Python 定位程式
                notifyPositioningServer({
                    session_id: sessionId,
                    xor_key: xorKey,
                    otp_list: studentOtpMap,
                    timeout: 5
                });

                // 建立每 30 秒自動更新 OTP 的定時器
                sessionIntervals[course_id] = setInterval(() => {
                    refreshCourseOtps(course_id);
                }, 30000); // 30,000 毫秒 = 30 秒

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

    // 若請求帶密碼則進行校驗；若舊版 App 未帶密碼則維持平滑放行相容
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

// 老師端查詢 OTP 名單 (回傳當前 OTP、XOR Key 與倒數秒數)
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
        if (allCourseIds.length > 0) {
            session = activeCourseSessions[allCourseIds[0]];
        }
    }

    if (!session) {
        return res.status(404).json({ success: false, message: '目前未開啟任何點名 Session' });
    }

    // 計算 30 秒週期剩餘秒數
    const elapsed = Math.floor((Date.now() - session.updated_at) / 1000);
    const remainingSeconds = Math.max(0, 30 - (elapsed % 30));

    console.log(`🔍 [查詢 OTP 列表] 課程: ${session.course_name} | XOR Key: ${session.xor_key} | 名單人數: ${Object.keys(session.students).length} | 倒數: ${remainingSeconds}s`);

    res.status(200).json({
        success: true,
        session_id: session.session_id,
        course_name: session.course_name,
        xor_key: session.xor_key,
        otp_list: session.students,
        remaining_seconds: remainingSeconds
    });
});

// 學生端獲取點名權杖 (取得當前最新 30 秒 OTP 與 XOR Key)
app.post('/api/session/get-token', (req, res) => {
    const { student_id } = req.body;
    const course_id = req.body.course_id ? parseInt(req.body.course_id) : 1;

    if (!student_id) {
        return res.status(400).json({ success: false, message: '請提供 student_id' });
    }

    let currentSession = activeCourseSessions[course_id];
    if (!currentSession) {
        const sessionKeys = Object.keys(activeCourseSessions);
        if (sessionKeys.length > 0) {
            currentSession = activeCourseSessions[sessionKeys[0]];
        }
    }

    if (!currentSession) {
        return res.status(404).json({ success: false, message: '目前沒有任何進行中的課堂點名' });
    }

    let myOtp = currentSession.students[student_id];
    if (!myOtp) {
        const fallbackOtp = Math.floor(100000 + Math.random() * 900000).toString();
        currentSession.students[student_id] = fallbackOtp;
        currentSession.studentRawList[student_id] = `學生_${student_id}`;
        myOtp = fallbackOtp;
    }

    const elapsed = Math.floor((Date.now() - currentSession.updated_at) / 1000);
    const remainingSeconds = Math.max(0, 30 - (elapsed % 30));

    // 🎯 學生端索取時，即時在終端機印出該生的學號、OTP 與 XOR Key
    console.log(`📱 [學生取權杖] 學號: ${student_id} | 取得 OTP: ${myOtp} | XOR Key: ${currentSession.xor_key} | 剩餘時效: ${remainingSeconds}s`);

    res.status(200).json({
        success: true,
        session_id: currentSession.session_id,
        otp: myOtp,
        xor_key: currentSession.xor_key,
        remaining_seconds: remainingSeconds
    });
});

// 老師「結束點名」接口 (停止定時器並回傳出席總結)
app.post('/api/session/stop', (req, res) => {
    const course_id = req.body.course_id ? parseInt(req.body.course_id) : 1;
    const { email, session_id } = req.body;

    // 清除 30 秒輪替定時器
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

    // 查詢最終出席人數統計
    const sqlCourseStudents = 'SELECT COUNT(*) as total FROM course_students WHERE course_id = ?';
    const sqlAttended = 'SELECT COUNT(DISTINCT user_id) as attended FROM check_in WHERE course_id = ?';

    db.query(sqlCourseStudents, [course_id], (cErr, cTotal) => {
        db.query(sqlAttended, [course_id], (aErr, aAttended) => {
            const totalStudents = (cTotal && cTotal[0]) ? cTotal[0].total : 0;
            const attendedStudents = (aAttended && aAttended[0]) ? aAttended[0].attended : 0;

            // 清理 Session
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

// 匯出當堂點名結果 CSV 報表接口
app.get('/api/session/export-csv', (req, res) => {
    const course_id = req.query.course_id ? parseInt(req.query.course_id) : 1;

    // 1. 取得課程資訊
    db.query('SELECT course_name FROM courses WHERE id = ?', [course_id], (cErr, cResults) => {
        const courseName = (cResults && cResults.length > 0) ? cResults[0].course_name : '點名課程';

        // 2. 取得修課名單
        const sqlStudents = 'SELECT student_id, student_name FROM course_students WHERE course_id = ?';
        db.query(sqlStudents, [course_id], (sErr, allStudents) => {
            if (sErr) return res.status(500).send('讀取名單失敗');

            const studentsList = (allStudents && allStudents.length > 0)
                ? allStudents
                : DEFAULT_STUDENTS.map(s => ({ student_id: s.id, student_name: s.name }));

            // 3. 取得出席記錄 (包含打卡裝置與打卡時間)
            const sqlCheckin = 'SELECT user_id, device_id, created_at FROM check_in WHERE course_id = ?';
            db.query(sqlCheckin, [course_id], (ckErr, checkinList) => {
                if (ckErr) return res.status(500).send('讀取打卡記錄失敗');

                // 建立打卡對應表
                let checkinMap = {};
                (checkinList || []).forEach(row => {
                    checkinMap[row.user_id.toString()] = {
                        device: row.device_id || '無',
                        time: row.created_at ? new Date(row.created_at).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' }) : '已簽到'
                    };
                });

                // 4. 組裝 CSV 內容 (加上 \uFEFF 避免 Windows Excel 開啟時中文亂碼)
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

                // 5. 設定檔案下載標頭
                const fileName = `attendance_course_${course_id}_${Date.now()}.csv`;
                res.setHeader('Content-Type', 'text/csv; charset=utf-8');
                res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);

                console.log(`📄 [匯出 CSV] 成功產生課程 ID: ${course_id} 的點名報表！`);
                res.status(200).send(csvContent);
            });
        });
    });
});

// ==========================================
// 5. 定位系統專用 API (規格 §2.1, §2.2, §2.4)
// ==========================================

// 2.1 定位計算程式上傳座標 (定位計算 Python -> Node)
app.post('/api/coords', (req, res) => {
    const { session_id, student_id, x, y, coordinate_system, timestamp } = req.body;

    // 1. 欄位驗證
    if (!session_id || !student_id || x === undefined || y === undefined || !coordinate_system || !timestamp) {
        return res.status(400).json({
            status: "failed",
            reason: "invalid_body",
            message: "缺少欄位或 JSON 解析失敗"
        });
    }

    // 2. 檢查 session 是否在進行中
    const session = activeSessionsById[session_id];
    if (!session) {
        return res.status(400).json({
            status: "failed",
            reason: "invalid_coord",
            message: "session_id 不存在或已結束"
        });
    }

    // 3. 檢查座標範圍 (grid32: 0 <= x, y <= 31)
    const numX = parseFloat(x);
    const numY = parseFloat(y);
    if (coordinate_system === 'grid32') {
        if (isNaN(numX) || isNaN(numY) || numX < 0 || numX > 31 || numY < 0 || numY > 31) {
            return res.status(400).json({
                status: "failed",
                reason: "invalid_coord",
                message: "座標超出 grid32 範圍 (0~31)"
            });
        }
    }

    // 4. 寫入 / 覆蓋 In-memory Buffer
    if (!coordBuffer[session_id]) {
        coordBuffer[session_id] = {
            coordinateSystem: coordinate_system,
            updatedAt: timestamp,
            students: {}
        };
    }

    coordBuffer[session_id].coordinateSystem = coordinate_system;
    coordBuffer[session_id].updatedAt = timestamp;
    coordBuffer[session_id].students[student_id] = {
        x: numX,
        y: numY,
        timestamp: timestamp
    };

    console.log(`📍 [收到座標] Session: ${session_id} | 學生: ${student_id} -> (${numX}, ${numY}) [${coordinate_system}]`);

    return res.status(200).json({
        status: "ok",
        accepted: true
    });
});

// 2.2 App 端拉取本次點名所有學生座標 (App -> Node)
app.post('/api/coords/get', (req, res) => {
    const { email, password, session_id } = req.body;

    if (!email || !password || !session_id) {
        return res.status(400).json({
            status: "failed",
            reason: "invalid_body",
            message: "請提供 email, password 與 session_id"
        });
    }

    const cleanEmail = email.toLowerCase().trim();
    db.query('SELECT * FROM user WHERE email = ? AND password = ?', [cleanEmail, password], (err, rows) => {
        if (err || !rows || rows.length === 0) {
            return res.status(401).json({
                status: "failed",
                reason: "invalid_credentials",
                message: "帳號或密碼錯誤"
            });
        }

        const session = activeSessionsById[session_id];
        if (!session) {
            return res.status(404).json({
                status: "failed",
                reason: "session_not_found",
                message: "查無此 session_id"
            });
        }

        if (session.teacher_email !== cleanEmail) {
            return res.status(403).json({
                status: "failed",
                reason: "forbidden",
                message: "此 session 不屬於該老師"
            });
        }

        const buffer = coordBuffer[session_id] || { coordinateSystem: "grid32", students: {} };
        const studentCoords = buffer.students || {};
        const count = Object.keys(studentCoords).length;

        return res.status(200).json({
            session_id: session_id,
            coordinate_system: buffer.coordinateSystem || "grid32",
            count: count,
            updated_at: buffer.updatedAt || new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' }),
            coords: studentCoords
        });
    });
});

// 2.4 老師清除本次定位資料 (App -> Node)
app.post('/api/coords/clear', (req, res) => {
    const { email, password, session_id } = req.body;

    if (!email || !password || !session_id) {
        return res.status(400).json({
            status: "failed",
            reason: "invalid_body",
            message: "請提供 email, password 與 session_id"
        });
    }

    const cleanEmail = email.toLowerCase().trim();
    db.query('SELECT * FROM user WHERE email = ? AND password = ?', [cleanEmail, password], (err, rows) => {
        if (err || !rows || rows.length === 0) {
            return res.status(401).json({
                status: "failed",
                reason: "invalid_credentials",
                message: "帳號或密碼錯誤"
            });
        }

        const session = activeSessionsById[session_id];
        if (session && session.teacher_email !== cleanEmail) {
            return res.status(403).json({
                status: "failed",
                reason: "forbidden",
                message: "此 session 不屬於該老師"
            });
        }

        let clearedCount = 0;
        if (coordBuffer[session_id]) {
            clearedCount = Object.keys(coordBuffer[session_id].students || {}).length;
            delete coordBuffer[session_id];
        }

        console.log(`🧹 [清除座標] Session: ${session_id} 已由 ${cleanEmail} 清除 (共清除了 ${clearedCount} 筆座標)`);

        return res.status(200).json({
            status: "ok",
            session_id: session_id,
            cleared: clearedCount
        });
    });
});

// 學生打卡入庫 (舊接口保留)
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
            : DEFAULT_STUDENTS;

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
    console.log('🚀 藍牙防作弊點名系統 - 定位與點名全功能後端已啟動！');
    console.log('🌐 運行埠口: 3000');
    console.log('📍 支援定位座標收發: /api/coords & /api/coords/get');
    console.log('⏱️ 支援 30 秒自動換碼 (Rolling OTP)');
    console.log('📄 支援 CSV 匯出: GET /api/session/export-csv');
    console.log('===========================================================');
});
