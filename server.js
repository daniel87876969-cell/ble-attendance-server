const express = require('express');
const mysql = require('mysql2');
const nodemailer = require('nodemailer');
const cors = require('cors');
const bodyParser = require('body-parser');

const app = express();
app.use(cors());
// 支援接收 JSON 與原始 CSV 純文字格式
app.use(bodyParser.json());
app.use(bodyParser.text({ type: ['text/csv', 'text/plain'] }));

app.get('/', (req, res) => {
    res.sendFile(__dirname + '/index.html');
});

// ==========================================
// 身分判斷輔助函式 (嚴格限定教師格式)
// ==========================================
function getRoleByEmail(email) {
    if (!email) return 'student';
    const lowerEmail = email.toLowerCase().trim();
    // 只有 @mail.mcu.edu.tw 認定為老師
    if (lowerEmail.endsWith('@mail.mcu.edu.tw')) {
        return 'teacher';
    }
    return 'student';
}

// ==========================================
// 1. 設定區域 (資料庫、郵件、Session 隔離池)
// ==========================================
const db = mysql.createConnection({
    host: 'localhost',
    user: 'root',
    password: 'knowledge',
    database: 'ble_mcu'
});

// 以 course_id 為 Key 的動態點名 Sessions (支援多課程同時點名與隔離)
let activeCourseSessions = {}; 
let tempCodes = {};

// 資料庫連線並自動建立/升級所需資料表
db.connect((err) => {
    if (err) {
        console.error('❌ 資料庫連線失敗:', err);
    } else {
        console.log('✅ 資料庫連線成功！');

        // 1. 確保 user 表結構完整包含 role
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
                    if (alterErr) console.error('⚠️ 新增 role 欄位失敗:', alterErr);
                    else console.log('🛠️ [資料庫升級] 成功為 user 資料表新增 role 欄位！');
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
            if (tErr) console.error('⚠️ 建立 courses 表失敗:', tErr);
            else console.log('📚 [資料庫] courses 表已就緒');
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
            if (tErr) console.error('⚠️ 建立 course_students 表失敗:', tErr);
            else console.log('👥 [資料庫] course_students 表已就緒');
        });

        // 4. 確保預設老師帳號存在 (符合 @mail.mcu.edu.tw 規範，免綁定裝置)
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

// 發送註冊驗證碼 (學生限 @me.mcu.edu.tw，教師嚴格限 @mail.mcu.edu.tw)
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

// 註冊接口 (教師端自動設置為 ANY_DEVICE)
app.post('/api/register', (req, res) => {
    const { user_id, name, email, password, code, device_id } = req.body;

    const record = tempCodes[email];
    if (!record) return res.status(400).json({ success: false, message: '請先獲取驗證碼' });
    if (record.code !== code) return res.status(400).json({ success: false, message: '驗證碼錯誤' });
    if (Date.now() > record.expires) return res.status(400).json({ success: false, message: '驗證碼已過期' });

    const role = getRoleByEmail(email);
    // 教師端完全不鎖定裝置，設為 ANY_DEVICE；學生則綁定裝置碼
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

// 登入接口 (教師完全免除裝置綁定驗證)
app.post('/api/auth/login', (req, res) => {
    const { email, password, device_id } = req.body;

    if (!email || !password) {
        return res.status(400).json({ success: false, message: '請填寫信箱與密碼' });
    }

    const cleanEmail = email.toLowerCase().trim();
    const inferredRole = getRoleByEmail(cleanEmail);

    console.log(`\n🔍 [收到登入請求] Email: ${cleanEmail} | 推測身分: ${inferredRole} | 傳入DeviceID: ${device_id || '無'}`);

    // 先查該信箱與密碼是否正確
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

        // 1. 若為教師：完全免除 device_id 檢查，但必須符合 @mail.mcu.edu.tw
        if (userRole === 'teacher') {
            if (!cleanEmail.endsWith('@mail.mcu.edu.tw')) {
                console.log(`⛔ [登入攔截] 教師信箱不符合規範 (@mail.mcu.edu.tw): ${cleanEmail}`);
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

        // 2. 若為學生：驗證裝置綁定
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

// 查詢某個老師底下的所有課程列表
app.get('/api/courses', (req, res) => {
    const teacherId = req.query.teacher_id || req.query.email;
    if (!teacherId) return res.status(400).json({ success: false, message: '請提供 teacher_id 或 email' });

    const sql = 'SELECT * FROM courses WHERE teacher_id = ? ORDER BY id DESC';
    db.query(sql, [teacherId], (err, results) => {
        if (err) return res.status(500).json({ success: false, message: '資料庫查詢失敗' });
        res.status(200).json({ success: true, courses: results });
    });
});

// 匯入課程與學生名單 (相容純 CSV 字串或 JSON 陣列)
app.post('/api/courses/import-csv', (req, res) => {
    let teacher_id = req.query.teacher_id || (req.body && req.body.teacher_id);
    let course_name = req.query.course_name || (req.body && req.body.course_name);
    let course_code = req.query.course_code || (req.body && req.body.course_code) || 'COURSE_' + Date.now();
    let students = [];

    // 若傳送的是 JSON 物件
    if (typeof req.body === 'object' && Array.isArray(req.body.students)) {
        students = req.body.students;
    } 
    // 若傳送的是純 CSV 文字
    else if (typeof req.body === 'string') {
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

    if (!teacher_id || !course_name) {
        return res.status(400).json({ success: false, message: '缺少 teacher_id 或 course_name' });
    }

    if (students.length === 0) {
        return res.status(400).json({ success: false, message: 'CSV 內未解析出任何學生名單' });
    }

    // 1. 建立課程
    const insertCourseSql = 'INSERT INTO courses (course_code, course_name, teacher_id) VALUES (?, ?, ?)';
    db.query(insertCourseSql, [course_code, course_name, teacher_id], (cErr, cResult) => {
        if (cErr) {
            console.error('建立課程失敗:', cErr);
            return res.status(500).json({ success: false, message: '建立課程失敗' });
        }

        const newCourseId = cResult.insertId;

        // 2. 批次匯入學生名單
        const studentValues = students.map(s => [newCourseId, s.student_id || s.id, s.student_name || s.name || '']);
        const insertStudentsSql = 'INSERT IGNORE INTO course_students (course_id, student_id, student_name) VALUES ?';

        db.query(insertStudentsSql, [studentValues], (sErr) => {
            if (sErr) {
                console.error('匯入學生名單失敗:', sErr);
                return res.status(500).json({ success: false, message: '匯入學生失敗' });
            }

            console.log(`📥 [課表匯入成功] 老師: ${teacher_id} 新增課程: ${course_name} (ID: ${newCourseId})，匯入 ${students.length} 位學生`);
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
// 4. 動態課程點名 Session 接口 (分流核心)
// ==========================================

// 老師「指定特定課程」啟動點名
app.post('/api/session/start', (req, res) => {
    const { email, course_id } = req.body;
    if (!email || !course_id) {
        return res.status(400).json({ success: false, message: '請提供 email 與 course_id' });
    }

    // 驗證啟動點名的是否為 @mail.mcu.edu.tw
    if (!email.toLowerCase().endsWith('@mail.mcu.edu.tw')) {
        return res.status(403).json({ success: false, message: '只有認證教師 (@mail.mcu.edu.tw) 能啟動點名 Session' });
    }

    const sqlCourse = 'SELECT * FROM courses WHERE id = ?';
    const sqlStudents = 'SELECT student_id, student_name FROM course_students WHERE course_id = ?';

    db.query(sqlCourse, [course_id], (cErr, courseResults) => {
        if (cErr || courseResults.length === 0) {
            return res.status(404).json({ success: false, message: '查無此課程' });
        }

        const currentCourse = courseResults[0];

        db.query(sqlStudents, [course_id], (sErr, studentResults) => {
            if (sErr) return res.status(500).json({ success: false, message: '讀取修課名單失敗' });

            const xorKey = Math.floor(10000000 + Math.random() * 90000000).toString();
            let studentOtpMap = {};

            studentResults.forEach(s => {
                studentOtpMap[s.student_id] = Math.floor(100000 + Math.random() * 900000).toString();
            });

            // 儲存於隔離的 Session 容器 (以 course_id 為鍵值)
            activeCourseSessions[course_id] = {
                course_id: currentCourse.id,
                course_name: currentCourse.course_name,
                course_code: currentCourse.course_code,
                teacher_email: email,
                xor_key: xorKey,
                students: studentOtpMap
            };

            console.log(`\n📢 [課程點名已啟動] 課程: ${currentCourse.course_name} (ID: ${course_id})`);
            console.log(`🔑 獨立 XOR Key: ${xorKey}，包含 ${studentResults.length} 位修課學生`);

            res.status(200).json({
                success: true,
                status: 'success',
                course_id: currentCourse.id,
                course_name: currentCourse.course_name,
                xor_key: xorKey
            });
        });
    });
});

// 老師端查詢某課程目前隨機 OTP 名單
app.post('/api/session/otp-list', (req, res) => {
    const { course_id } = req.body;
    const session = activeCourseSessions[course_id];

    if (!session) {
        return res.status(404).json({ success: false, message: '該課程目前未開啟點名' });
    }

    res.status(200).json({
        success: true,
        course_name: session.course_name,
        otp_list: session.students
    });
});

// 學生端「指定課程」獲取點名權杖
app.post('/api/session/get-token', (req, res) => {
    const { student_id, course_id } = req.body;

    if (!student_id || !course_id) {
        return res.status(400).json({ success: false, message: '請提供 student_id 與 course_id' });
    }

    const currentSession = activeCourseSessions[course_id];
    if (!currentSession) {
        return res.status(404).json({ success: false, message: '該課程目前未開啟點名或已結束' });
    }

    const myOtp = currentSession.students[student_id];
    if (!myOtp) {
        const fallbackOtp = Math.floor(100000 + Math.random() * 900000).toString();
        currentSession.students[student_id] = fallbackOtp;

        console.log(`📱 [動態補發] 課程 ${course_id} 學生 ${student_id} 取得 OTP: ${fallbackOtp}`);
        return res.status(200).json({
            success: true,
            otp: fallbackOtp,
            xor_key: currentSession.xor_key
        });
    }

    console.log(`📱 [學生取權杖] 課程 ${course_id} 學生 ${student_id} 提取 OTP: ${myOtp}`);
    res.status(200).json({
        success: true,
        otp: myOtp,
        xor_key: currentSession.xor_key
    });
});

// 學生打卡入庫
app.post('/api/check-in', (req, res) => {
    const { student_info, device_address, course_id } = req.body;

    if (!student_info || !course_id) {
        return res.status(400).json({ success: false, message: '資料缺少 (student_info 或 course_id)' });
    }

    const sql = 'INSERT INTO check_in (user_id, device_id, course_id) VALUES (?, ?, ?)';
    db.query(sql, [student_info, device_address, course_id], (err) => {
        if (err) {
            console.error('寫入點名紀錄失敗:', err);
            return res.status(500).json({ success: false, message: 'Database Error', error: err });
        }
        console.log(`✅ [點名成功] 學生 ${student_info} 已簽到課程 ID: ${course_id}`);
        res.status(200).json({ success: true, message: 'Success' });
    });
});

// 查詢特定課程出席報表
app.get('/api/session/attendance-status', (req, res) => {
    const course_id = req.query.course_id;
    if (!course_id) return res.status(400).json({ success: false, message: '請提供 course_id' });

    const sqlCourseStudents = 'SELECT student_id, student_name FROM course_students WHERE course_id = ?';
    const sqlAttended = 'SELECT DISTINCT user_id FROM check_in WHERE course_id = ?';

    db.query(sqlCourseStudents, [course_id], (err, allStudents) => {
        if (err) return res.status(500).json([]);

        db.query(sqlAttended, [course_id], (aErr, attendedResults) => {
            if (aErr) return res.status(500).json([]);

            const attendedIds = new Set(attendedResults.map(r => r.user_id.toString()));
            const report = allStudents.map(s => ({
                id: s.student_id,
                name: s.student_name,
                status: attendedIds.has(s.student_id.toString()) ? "✅ 已出席" : "❌ 缺席"
            }));

            res.json(report);
        });
    });
});

// 取得使用者清單
app.get('/api/users', (req, res) => {
    db.query('SELECT user_id, name, email, device_id, role FROM user', (err, results) => {
        res.json(results);
    });
});

app.listen(3000, '0.0.0.0', () => {
    console.log('===========================================================');
    console.log('🚀 藍牙防作弊點名系統 - 多課程分流後端伺服器已啟動！');
    console.log('🌐 運行埠口: 3000');
    console.log('🔒 教師信箱嚴格限制: @mail.mcu.edu.tw (免綁定裝置)');
    console.log('===========================================================');
});
