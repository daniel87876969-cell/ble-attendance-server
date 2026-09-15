const express = require('express');
const mysql = require('mysql2');
const nodemailer = require('nodemailer');
const cors = require('cors');
const bodyParser = require('body-parser');

const app = express();
app.use(cors());
app.use(bodyParser.json());

app.get('/', (req, res) => {
    res.sendFile(__dirname + '/index.html');
});

// ==========================================
// 1. 設定區域 (資料庫、郵件、5人模擬課程)
// ==========================================
const db = mysql.createConnection({
    host: 'localhost',
    user: 'root',
    password: 'knowledge',
    database: 'ble_mcu'
});

const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: 'nhentai696@gmail.com',
        pass: 'ywikezgwjnasegke'
    }
});

let tempCodes = {}; 
let activeSessions = {}; 

// 5 人固定模擬課程配置
const MOCK_COURSE = {
    course_id: 1, // 對齊資料庫 INT 欄位
    course_code: "MCU_BLE_PROJECT",
    course_name: "行動應用與物聯網專案實作",
    teacher_email: "teacher@mcu.edu.tw",
    students: [
        { id: "12360305", name: "組員A" },
        { id: "12360615", name: "組員B" },
        { id: "12360333", name: "組員C" },
        { id: "12360342", name: "組員D" },
        { id: "12360596", name: "組員E" }
    ]
};

// ==========================================
// 2. 帳號與登入接口
// ==========================================
app.post('/api/send-code', (req, res) => {
    const { email } = req.body;

    if (!email || (!email.endsWith('@me.mcu.edu.tw') && !email.endsWith('@gmail.com'))) {
        return res.status(403).json({ success: false, message: '限用學校信箱或常用信箱' });
    }

    const code = Math.floor(100000 + Math.random() * 900000).toString(); 
    tempCodes[email] = { code, expires: Date.now() + 300000 }; 

    const mailOptions = {
        from: '"藍牙點名系統" <nhentai696@gmail.com>',
        to: email,
        subject: '【點名系統】註冊驗證碼',
        text: `您的驗證碼是：${code}\n請於 5 分鐘內輸入此代碼以完成註冊。\n(若非本人操作請忽略)`
    };

    transporter.sendMail(mailOptions, (err, info) => {
        if (err) {
            console.error('寄信失敗:', err);
            return res.status(500).json({ success: false, message: '寄信失敗' });
        }
        console.log(`📩 [驗證碼發送] 成功寄送給 ${email}，密碼為: ${code}`); 
        res.status(200).json({ success: true, message: 'Sent' });
    });
});

app.post('/api/register', (req, res) => {
    const { user_id, name, email, password, code, device_id } = req.body;

    const record = tempCodes[email];
    if (!record) return res.status(400).json({ success: false, message: '請先獲取驗證碼' });
    if (record.code !== code) return res.status(400).json({ success: false, message: '驗證碼錯誤' });
    if (Date.now() > record.expires) return res.status(400).json({ success: false, message: '驗證碼已過期' });

    db.query('SELECT * FROM user WHERE user_id = ?', [user_id], (checkErr, checkResults) => {
        if (checkErr) return res.status(500).json({ success: false, message: '資料庫檢查錯誤' });
        
        if (checkResults && checkResults.length > 0) {
            console.log(`❌ [註冊阻擋] 學號 ${user_id} 已存在，防止重複覆蓋。`);
            return res.status(400).json({ success: false, message: '此學號已註冊過，無法重複註冊！' });
        }

        const sql = `INSERT INTO user (user_id, name, password, email, device_id) VALUES (?, ?, ?, ?, ?)`;
        db.query(sql, [user_id, name, password, email, device_id], (err, result) => {
            if (err) {
                console.error(err);
                if (err.code === 'ER_DUP_ENTRY') return res.status(400).json({ success: false, message: '此學號或信箱已註冊過' });
                return res.status(500).json({ success: false, message: '資料庫錯誤' });
            }
            delete tempCodes[email];
            console.log(`👤 [新用戶註冊] 學號: ${user_id} 註冊成功並綁定裝置！`);
            res.status(200).json({ success: true, status: 'success', message: 'Success' });
        });
    });
});

// 🎯 登入驗證：補齊 success: true、status: "success" 以及使用者物件
app.post('/api/auth/login', (req, res) => {
    const { email, password, device_id } = req.body;

    if (!email || !password || !device_id) {
        return res.status(400).json({ success: false, message: '所有欄位皆為必填' });
    }

    const sql = 'SELECT * FROM user WHERE email = ? AND password = ? AND device_id = ?';
    db.query(sql, [email, password, device_id], (err, results) => {
        if (err) return res.status(500).json({ success: false, message: '資料庫查詢錯誤' });
        
        if (results && results.length > 0) {
            console.log(`🔐 [用戶登入] ${email} 登入成功！`);
            res.status(200).json({
                success: true,
                status: 'success',
                message: 'Success',
                token: 'mock_token_' + results[0].user_id,
                user: {
                    user_id: results[0].user_id,
                    name: results[0].name,
                    email: results[0].email
                }
            });
        } else {
            console.log(`❌ [登入失敗] ${email} 密碼錯誤或裝置未綁定`);
            res.status(401).json({ success: false, message: '登入失敗' });
        }
    });
});

// ==========================================
// 3. 模擬課程點名 Session 接口
// ==========================================
app.post('/api/session/start', (req, res) => {
    const { email } = req.body;
    if (!email) return res.status(400).json({ success: false, message: '請提供電子郵件' });

    console.log(`\n📢 [老師點名觸發] 啟動課程: ${MOCK_COURSE.course_name} (${MOCK_COURSE.course_code})`);
    
    const xorKey = Math.floor(10000000 + Math.random() * 90000000).toString();

    activeSessions[email] = {
        course_id: MOCK_COURSE.course_id,
        course_name: MOCK_COURSE.course_name,
        course_code: MOCK_COURSE.course_code,
        xor_key: xorKey,
        students: {}
    };

    MOCK_COURSE.students.forEach(student => {
        const studentOtp = Math.floor(100000 + Math.random() * 900000).toString();
        activeSessions[email].students[student.id] = studentOtp;
    });

    console.log(`💾 [點名初始化] XOR Key: ${xorKey}`);
    console.log(`👥 已為 5 位專案組員生成專屬 OTP 表。`);

    res.status(200).json({
        success: true,
        status: "success",
        course_id: MOCK_COURSE.course_id,
        course_name: MOCK_COURSE.course_name,
        xor_key: xorKey
    });
});

app.post('/api/session/otp-list', (req, res) => {
    const { email } = req.body;
    const session = activeSessions[email];

    if (!session) {
        return res.status(404).json({ success: false, message: '目前未開啟任何點名 Session' });
    }

    res.status(200).json({
        success: true,
        course_name: session.course_name,
        otp_list: session.students
    });
});

app.post('/api/session/get-token', (req, res) => {
    const { student_id } = req.body;

    const sessionEmails = Object.keys(activeSessions);
    if (sessionEmails.length === 0) {
        return res.status(404).json({ success: false, message: '目前沒有任何進行中的課堂點名' });
    }

    const currentSession = activeSessions[sessionEmails[0]];
    const myOtp = currentSession.students[student_id];

    if (!myOtp) {
        const fallbackOtp = Math.floor(100000 + Math.random() * 900000).toString();
        currentSession.students[student_id] = fallbackOtp;
        
        console.log(`📱 [動態補發] 學生 ${student_id} 取得 OTP: ${fallbackOtp}`);
        return res.status(200).json({
            success: true,
            otp: fallbackOtp,
            xor_key: currentSession.xor_key
        });
    }

    console.log(`📱 [學生獲取權杖] 學生 ${student_id} 提取 OTP: ${myOtp}`);
    res.status(200).json({
        success: true,
        otp: myOtp,
        xor_key: currentSession.xor_key
    });
});

app.post('/api/check-in', (req, res) => {
    const { student_info, device_address } = req.body;

    if (!student_info) return res.status(400).json({ success: false, message: '資料缺少' });

    const sql = 'INSERT INTO check_in (user_id, device_id, course_id) VALUES (?, ?, ?)';
    db.query(sql, [student_info, device_address, MOCK_COURSE.course_id], (err) => {
        if (err) {
            console.error('寫入點名紀錄失敗:', err);
            return res.status(500).json({ success: false, message: 'Database Error', error: err });
        }
        console.log(`✅ [點名資料入庫] 學生 ${student_info} 已成功登錄至資料庫！`);
        res.status(200).json({ success: true, message: 'Success' });
    });
});

// 獲取 5 人出席狀態表格
app.get('/api/session/attendance-status', (req, res) => {
    db.query('SELECT DISTINCT user_id FROM check_in WHERE course_id = ?', [MOCK_COURSE.course_id], (err, results) => {
        if (err) return res.status(500).json([]);
        
        const attendedIds = new Set(results.map(row => row.user_id.toString()));
        
        const report = MOCK_COURSE.students.map(s => ({
            id: s.id,
            name: s.name,
            course_name: MOCK_COURSE.course_name,
            status: attendedIds.has(s.id) ? "✅ 已出席" : "❌ 缺席"
        }));
        
        res.json(report);
    });
});

app.get('/api/users', (req, res) => {
    db.query('SELECT user_id, name, email, device_id FROM user', (err, results) => {
        res.json(results);
    });
});

app.listen(3000, '0.0.0.0', () => {
    console.log('===========================================================');
    console.log('🚀 藍牙防作弊點名系統 - 後端專用對接伺服器已成功啟動！');
    console.log('🌐 目前運行於本地埠口: 3000');
    console.log('🔗 請在終端機啟動對應的通道: ngrok http 3000');
    console.log('===========================================================');
});
