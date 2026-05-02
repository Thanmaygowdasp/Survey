const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

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

// ---------- BREVO MAIL FUNCTION ----------
async function sendApprovalMail(toEmail, code) {
  try {
    await fetch("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      headers: {
        "accept": "application/json",
        "api-key": process.env.BREVO_API_KEY,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        sender: {
          email: process.env.SENDER_EMAIL,
          name: "Survey Team",
        },
        to: [{ email: toEmail }],
        subject: "Survey Participation Confirmation",
        htmlContent: `
          <h3>Hello,</h3>
          <p>Thank you for participating in our survey.</p>
          <p>Your 6 digit confirmation code:</p>
          <h2>${code}</h2>
          <p>Please share this with our team member only.</p>
        `,
      }),
    });

    console.log("Mail sent to", toEmail);
  } catch (e) {
    console.log("MAIL ERROR:", e);
  }
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

// ---------- UPDATE STATUS + SEND MAIL ----------
app.post('/update-status', (req, res) => {
  const { id, status } = req.body;

  db.get('SELECT * FROM surveys WHERE id=?', [id], (err, row) => {
    if (!row) return res.json({ msg: "Survey not found" });

    db.run('UPDATE surveys SET status=? WHERE id=?', [status, id], async () => {
      if (status === 'active') {
        const code = Math.floor(100000 + Math.random() * 900000);
        await sendApprovalMail(row.email, code);
      }
      res.json({ msg: 'Updated & Mail Sent' });
    });
  });
});

// ---------- DELETE SURVEY ----------
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