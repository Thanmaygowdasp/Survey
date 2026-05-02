const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const nodemailer = require('nodemailer');

const app = express();
const db = new sqlite3.Database('./database.db');

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ---------- DATABASE ----------
db.run(`
CREATE TABLE IF NOT EXISTS surveys (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT,
  email TEXT,
  answers TEXT,
  status TEXT,
  surveyCode TEXT
)`);

// ---------- GMAIL SMTP ----------
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
      user: process.env.EMAIL_USER,
      pass: process.env.EMAIL_PASS
  }
});

transporter.verify(function (error, success) {
  if (error) {
    console.log("SMTP ERROR:", error);
  } else {
    console.log("SMTP READY");
  }
});

function sendApprovalMail(toEmail, code, name) {
  transporter.sendMail({
    from: process.env.EMAIL_USER,
    to: toEmail,
    subject: 'Survey Participation Confirmation',
    html: `
      <h3>Hello,</h3>
      <p>Thank you for participating in our survey.</p>
      <p>Your 6 digit confirmation code:</p>
      <h2>${code}</h2>
      <h3>Please Share this with our team Member only</h3>
    `
  });
}

// ---------- SUBMIT SURVEY ----------
app.post('/submit-survey', (req, res) => {
  const { name, email, answers } = req.body;

  const surveyCode = Math.floor(10000 + Math.random() * 90000);

  db.run(
    'INSERT INTO surveys (name,email,answers,status,surveyCode) VALUES (?,?,?,?,?)',
    [name, email, JSON.stringify(answers), 'pending', surveyCode],
    function () {
      res.json({ msg: 'Survey submitted!', surveyCode });
    }
  );
});

// ---------- ADMIN LIST ----------
app.get('/admin/surveys', (req, res) => {
  db.all('SELECT * FROM surveys ORDER BY id DESC', [], (err, rows) => {
    res.json(rows);
  });
});

// ---------- UPDATE STATUS + MAIL ----------
app.post('/update-status', (req, res) => {
  const { id, status } = req.body;

  db.get('SELECT * FROM surveys WHERE id=?', [id], (err, row) => {
    db.run('UPDATE surveys SET status=? WHERE id=?', [status, id], () => {
      if (status === 'active') {
        const code = Math.floor(100000 + Math.random() * 900000);
        sendApprovalMail(row.email, code, row.name);
      }
      res.json({ msg: 'Updated & Mail Sent' });
    });
  });
});

// ---------- DELETE ----------
app.delete('/delete-survey/:id', (req, res) => {
  const id = req.params.id;

  db.run('DELETE FROM surveys WHERE id=?', [id], function (err) {
    if (err) return res.json({ msg: 'Delete error' });
    res.json({ msg: 'Deleted successfully' });
  });
});

// ---------- ANALYTICS ----------
app.get('/analytics', (req, res) => {
  db.all('SELECT * FROM surveys', [], (err, rows) => {
    let total = rows.length;
    let usage = { low:0, medium:0, high:0 };
    let purpose = { entertainment:0, education:0, business:0, chatting:0 };
    let addictionYes = 0;
    let mentalNegative = 0;

    rows.forEach(r=>{
      const a = JSON.parse(r.answers);

      if(a.q0 === "5+ hours") usage.high++;
      else if(a.q0 === "3–5 hours") usage.medium++;
      else usage.low++;

      if(a.q1 === "Entertainment") purpose.entertainment++;
      if(a.q1 === "Education") purpose.education++;
      if(a.q1 === "Business") purpose.business++;
      if(a.q1 === "Chatting") purpose.chatting++;

      if(a.q4 === "Yes") addictionYes++;
      if(a.q3 === "Negative") mentalNegative++;
    });

    res.json({
      summary:[
        {label:"Total Surveys", value: total},
        {label:"Addiction %", value: total?((addictionYes/total)*100).toFixed(1):0},
        {label:"Mental Negative %", value: total?((mentalNegative/total)*100).toFixed(1):0}
      ],
      usage, purpose
    });
  });
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () =>
  console.log(`Server running on port ${PORT}`)
);