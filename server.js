// ==========================================
// IMPORTS
// ==========================================

require("dotenv").config();

const express = require("express");
const session = require("express-session");
const connectPgSimple = require("connect-pg-simple");
const rateLimit = require("express-rate-limit");
const bcrypt = require("bcrypt");
const crypto = require("crypto");
const { Pool } = require("pg");
const path = require("path");

// ==========================================
// APP SETUP
// ==========================================

const app = express();

app.use(express.json({ limit: "100kb" }));
app.use(express.urlencoded({ extended: false }));

// ==========================================
// DATABASE
// ==========================================

const pool = new Pool({
  host: process.env.PGHOST || "localhost",
  port: Number(process.env.PGPORT || 5432),
  user: process.env.PGUSER || "postgres",
  password: process.env.PGPASSWORD,
  database: process.env.PGDATABASE || "survey_db",
  ssl: process.env.PGSSL === "true"
    ? { rejectUnauthorized: false }
    : undefined
});

if (process.env.NODE_ENV === "production") {
  app.set("trust proxy", 1);
}

// ==========================================
// SESSION CONFIGURATION
// ==========================================

if (!process.env.SESSION_SECRET) {
  throw new Error("SESSION_SECRET is missing from .env");
}

const PgSessionStore = connectPgSimple(session);

app.use(
  session({
    store: new PgSessionStore({
      pool,
      tableName: "user_sessions",
      createTableIfMissing: true
    }),

    name: "survey.sid",
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    rolling: true,

    cookie: {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "strict",
      maxAge: 30 * 60 * 1000
    }
  })
);

// ==========================================
// RATE LIMITERS
// ==========================================

const participantRequestLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: {
    msg: "Too many login requests. Please try again later."
  }
});

const adminLoginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: {
    msg: "Too many password attempts. Please try again later."
  }
});

// ==========================================
// HELPER FUNCTIONS
// ==========================================

function hashToken(token) {
  return crypto
    .createHash("sha256")
    .update(token)
    .digest("hex");
}

function regenerateSession(req) {
  return new Promise((resolve, reject) => {
    req.session.regenerate((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function saveSession(req) {
  return new Promise((resolve, reject) => {
    req.session.save((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function destroySession(req) {
  return new Promise((resolve, reject) => {
    if (!req.session) return resolve();

    req.session.destroy((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

// ==========================================
// ADMIN AUTHENTICATION MIDDLEWARE
// ==========================================

function requireAdmin(req, res, next) {
  if (req.session && req.session.isAdmin === true) {
    return next();
  }

  return res.status(401).json({
    msg: "Admin authentication required"
  });
}

// ==========================================
// PARTICIPANT AUTHENTICATION MIDDLEWARE
// ==========================================

async function requireParticipant(req, res, next) {
  try {
    const participant = req.session?.participant;

    if (!participant?.requestId) {
      return res.redirect("/");
    }

    const result = await pool.query(
      `SELECT status
       FROM login_requests
       WHERE id = $1`,
      [participant.requestId]
    );

    if (
      result.rows.length === 0 ||
      result.rows[0].status !== "approved"
    ) {
      await destroySession(req);
      return res.redirect("/");
    }

    next();

  } catch (error) {
    console.error("PARTICIPANT AUTH ERROR:", error);

    res.status(500).send(
      "Unable to verify access. Please try again."
    );
  }
}

// ==========================================
// DATABASE TABLE INITIALIZATION
// ==========================================

async function createTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS surveys (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL,
      answers JSONB NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      survey_code VARCHAR(6),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await pool.query(`
    ALTER TABLE login_requests
      ADD COLUMN IF NOT EXISTS name VARCHAR(150),
      ADD COLUMN IF NOT EXISTS email VARCHAR(255),
      ADD COLUMN IF NOT EXISTS request_token_hash TEXT
  `);

  console.log("Database tables ready");
}

// ==========================================
// ADMIN LOGIN
// ==========================================

app.post(
  "/admin/login",
  adminLoginLimiter,
  async (req, res) => {
    try {
      const password = req.body?.password;
      const passwordHash = process.env.ADMIN_PASSWORD_HASH;

      if (!password || typeof password !== "string") {
        return res.status(400).json({
          msg: "Enter the admin password"
        });
      }

      if (!passwordHash) {
        console.error("ADMIN_PASSWORD_HASH is missing");

        return res.status(503).json({
          msg: "Admin login is not configured"
        });
      }

      const valid = await bcrypt.compare(
        password,
        passwordHash
      );

      if (!valid) {
        return res.status(401).json({
          msg: "Incorrect password"
        });
      }

      await regenerateSession(req);

      req.session.isAdmin = true;

      await saveSession(req);

      res.json({
        msg: "Admin login successful"
      });

    } catch (error) {
      console.error("ADMIN LOGIN ERROR:", error);

      res.status(500).json({
        msg: "Admin login failed"
      });
    }
  }
);

// ==========================================
// ADMIN LOGOUT
// ==========================================

app.post(
  "/admin/logout",
  requireAdmin,
  async (req, res) => {
    try {
      await destroySession(req);

      res.clearCookie("survey.sid");

      res.json({
        msg: "Logged out successfully"
      });

    } catch (error) {
      console.error("ADMIN LOGOUT ERROR:", error);

      res.status(500).json({
        msg: "Logout failed"
      });
    }
  }
);

// ==========================================
// CHECK ADMIN SESSION
// ==========================================

app.get("/admin/session", (req, res) => {
  res.json({
    isAdmin: req.session?.isAdmin === true,
    authenticated: req.session?.isAdmin === true
  });
});

// ==========================================
// PARTICIPANT: CREATE LOGIN REQUEST
// ==========================================

app.post(
  "/login-request",
  participantRequestLimiter,
  async (req, res) => {
    try {
      const name =
        typeof req.body?.name === "string"
          ? req.body.name.trim()
          : "";

      const email =
        typeof req.body?.email === "string"
          ? req.body.email.trim().toLowerCase()
          : "";

      const emailPattern =
        /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

      if (
        !name ||
        name.length > 150 ||
        !emailPattern.test(email) ||
        email.length > 255
      ) {
        return res.status(400).json({
          msg: "Enter a valid name and email address"
        });
      }

      // Expire previous pending request from this browser.

      const previousRequestId =
        req.session?.loginRequest?.requestId;

      if (previousRequestId) {
        await pool.query(
          `UPDATE login_requests
           SET status = 'expired'
           WHERE id = $1
           AND status = 'pending'`,
          [previousRequestId]
        );
      }

      const requestToken =
        crypto.randomBytes(32).toString("hex");

      const requestTokenHash =
        hashToken(requestToken);

      const result = await pool.query(
        `INSERT INTO login_requests
          (name, email, status, request_token_hash)
         VALUES ($1, $2, 'pending', $3)
         RETURNING id`,
        [name, email, requestTokenHash]
      );

      await regenerateSession(req);

      req.session.loginRequest = {
        requestId: result.rows[0].id,
        requestToken
      };

      await saveSession(req);

      res.status(201).json({
        msg: "Approval request submitted",
        status: "pending"
      });

    } catch (error) {
      console.error("LOGIN REQUEST ERROR:", error);

      res.status(500).json({
        msg: "Could not submit login request"
      });
    }
  }
);

// ==========================================
// PARTICIPANT: CHECK APPROVAL STATUS
// ==========================================

app.get("/login-status", async (req, res) => {
  try {
    if (req.session?.participant?.requestId) {
      return res.json({
        status: "approved",
        redirect: "/survey.html"
      });
    }

    const loginRequest = req.session?.loginRequest;

    if (
      !loginRequest?.requestId ||
      !loginRequest?.requestToken
    ) {
      return res.status(401).json({
        msg: "No active login request"
      });
    }

    const result = await pool.query(
      `SELECT id, name, email, status, request_token_hash
       FROM login_requests
       WHERE id = $1`,
      [loginRequest.requestId]
    );

    if (result.rows.length === 0) {
      await destroySession(req);

      return res.status(404).json({
        msg: "Login request not found"
      });
    }

    const request = result.rows[0];

    if (
      hashToken(loginRequest.requestToken) !==
      request.request_token_hash
    ) {
      await destroySession(req);

      return res.status(403).json({
        msg: "Invalid login request"
      });
    }

    if (request.status === "pending") {
      return res.json({
        status: "pending"
      });
    }

    if (
      request.status === "rejected" ||
      request.status === "expired"
    ) {
      await destroySession(req);
      res.clearCookie("survey.sid");

      return res.json({
        status: request.status
      });
    }

    if (request.status === "approved") {
      await regenerateSession(req);

      req.session.participant = {
        requestId: request.id,
        name: request.name,
        email: request.email
      };

      await saveSession(req);

      return res.json({
        status: "approved",
        redirect: "/survey.html"
      });
    }

    res.json({
      status: request.status
    });

  } catch (error) {
    console.error("LOGIN STATUS ERROR:", error);

    res.status(500).json({
      msg: "Could not check approval status"
    });
  }
});
// ==========================================
// ADMIN: GET ALL LOGIN REQUESTS
// ==========================================

app.get(
  "/admin/login-requests",
  requireAdmin,
  async (req, res) => {
    try {
      const result = await pool.query(`
        SELECT
          id,
          name,
          email,
          status,
          created_at AS "createdAt"
        FROM login_requests
        WHERE status = 'pending'
        ORDER BY created_at ASC
      `);

      res.json(result.rows);

    } catch (error) {
      console.error("LOGIN REQUEST LIST ERROR:", error);

      res.status(500).json({
        msg: "Could not load login requests"
      });
    }
  }
);


// ==========================================
// ADMIN: GET PARTICIPANT HISTORY
// ==========================================

app.get(
  "/admin/participant-history",
  requireAdmin,
  async (req, res) => {
    try {
      const result = await pool.query(`
        SELECT
          id,
          name,
          email,
          status,
          created_at AS "createdAt",
          verified_at AS "verifiedAt"
        FROM login_requests
        ORDER BY created_at DESC
      `);

      res.set("Cache-Control", "no-store");
      res.json(result.rows);

    } catch (error) {
      console.error("PARTICIPANT HISTORY ERROR:", error);

      res.status(500).json({
        msg: "Could not load participant history"
      });
    }
  }
);

// ==========================================
// ADMIN: DELETE PARTICIPANT HISTORY
// ==========================================

app.delete(
  "/admin/participant-history/:id",
  requireAdmin,
  async (req, res) => {
    try {
      const id = Number(req.params.id);

      if (!Number.isInteger(id) || id <= 0) {
        return res.status(400).json({
          msg: "Invalid participant ID"
        });
      }

      const result = await pool.query(
        `DELETE FROM login_requests
         WHERE id = $1
         RETURNING id`,
        [id]
      );

      if (result.rowCount === 0) {
        return res.status(404).json({
          msg: "Participant history not found"
        });
      }

      res.json({
        msg: "Participant history deleted successfully"
      });

    } catch (error) {
      console.error("DELETE PARTICIPANT HISTORY ERROR:", error);

      res.status(500).json({
        msg: "Could not delete participant history"
      });
    }
  }
);
// ADMIN: DELETE PARTICIPANT HISTORY
app.delete("/admin/participant-history/:id", requireAdmin, async (req, res) => {
  try {
    const id = Number(req.params.id);

    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ msg: "Invalid participant ID" });
    }

    const result = await pool.query(
      "DELETE FROM login_requests WHERE id = $1 RETURNING id",
      [id]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ msg: "Participant history not found" });
    }

    res.json({ msg: "Participant history deleted successfully" });

  } catch (error) {
    console.error("DELETE PARTICIPANT HISTORY ERROR:", error);
    res.status(500).json({ msg: "Could not delete participant history" });
  }
});

// ==========================================
// ADMIN: APPROVE LOGIN REQUEST
// ==========================================

app.post(
  "/admin/approve/:id",
  requireAdmin,
  async (req, res) => {
    try {
      const id = Number(req.params.id);

      if (!Number.isInteger(id) || id <= 0) {
        return res.status(400).json({
          msg: "Invalid request ID"
        });
      }

      const result = await pool.query(
        `UPDATE login_requests
         SET status = 'approved'
         WHERE id = $1
         AND status = 'pending'
         RETURNING id`,
        [id]
      );

      if (result.rowCount === 0) {
        return res.status(404).json({
          msg: "Pending request not found"
        });
      }

      res.json({
        msg: "Participant approved"
      });

    } catch (error) {
      console.error("APPROVE REQUEST ERROR:", error);

      res.status(500).json({
        msg: "Could not approve request"
      });
    }
  }
);

// ==========================================
// ADMIN: REJECT LOGIN REQUEST
// ==========================================

app.post(
  "/admin/reject/:id",
  requireAdmin,
  async (req, res) => {
    try {
      const id = Number(req.params.id);

      if (!Number.isInteger(id) || id <= 0) {
        return res.status(400).json({
          msg: "Invalid request ID"
        });
      }

      const result = await pool.query(
        `UPDATE login_requests
         SET status = 'rejected'
         WHERE id = $1
         AND status = 'pending'
         RETURNING id`,
        [id]
      );

      if (result.rowCount === 0) {
        return res.status(404).json({
          msg: "Pending request not found"
        });
      }

      res.json({
        msg: "Participant rejected"
      });

    } catch (error) {
      console.error("REJECT REQUEST ERROR:", error);

      res.status(500).json({
        msg: "Could not reject request"
      });
    }
  }
);
// GET APPROVED PARTICIPANT DETAILS

app.get(
  "/participant/session",
  requireParticipant,
  (req, res) => {
    res.json({
      name: req.session.participant.name,
      email: req.session.participant.email
    });
  }
);
// ==========================================
// PROTECT SURVEY PAGE
// ==========================================

app.get(
  "/survey.html",
  requireParticipant,
  (req, res) => {
    res.sendFile(
      path.join(__dirname, "public", "survey.html")
    );
  }
);

// ==========================================
// SUBMIT SURVEY
// ONLY APPROVED PARTICIPANTS
// ==========================================

app.post("/submit-survey", async (req, res) => {

  const participant = req.session?.participant;

  if (!participant?.requestId) {
    return res.status(401).json({
      msg: "You need approval before submitting the survey"
    });
  }

  const answers = req.body?.answers;

  if (
    !answers ||
    typeof answers !== "object" ||
    Array.isArray(answers)
  ) {
    return res.status(400).json({
      msg: "Missing or invalid survey answers"
    });
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const requestResult = await client.query(
      `SELECT id, name, email, status
       FROM login_requests
       WHERE id = $1
       FOR UPDATE`,
      [participant.requestId]
    );

    if (
      requestResult.rows.length === 0 ||
      requestResult.rows[0].status !== "approved"
    ) {
      await client.query("ROLLBACK");

      await destroySession(req);

      return res.status(403).json({
        msg: "Your survey access is no longer active"
      });
    }

    const approvedParticipant = requestResult.rows[0];

    // Save survey response.

    const surveyResult = await client.query(
      `INSERT INTO surveys
       (name, email, answers, status)
       VALUES ($1, $2, $3, 'pending')
       RETURNING id`,
      [
        approvedParticipant.name,
        approvedParticipant.email,
        answers
      ]
    );

    // Mark this login request as completed.

    await client.query(
      `UPDATE login_requests
       SET status = 'verified',
           verified_at = CURRENT_TIMESTAMP
       WHERE id = $1`,
      [participant.requestId]
    );

    await client.query("COMMIT");

    // Destroy participant session only after successful submission.

    await destroySession(req);

    res.clearCookie("survey.sid");

    res.status(201).json({
      msg: "Thank you for participating in our survey!",
      surveyId: surveyResult.rows[0].id
    });

  } catch (error) {

    await client.query("ROLLBACK").catch(() => {});

    console.error("SUBMIT DATABASE ERROR:", error);

    res.status(500).json({
      msg: "Failed to save survey. Please try again."
    });

  } finally {
    client.release();
  }
});

// ==========================================
// EXISTING BREVO EMAIL FUNCTION
// ==========================================

async function sendApprovalMail(toEmail, code) {
  try {
    const response = await fetch(
      "https://api.brevo.com/v3/smtp/email",
      {
        method: "POST",

        headers: {
          accept: "application/json",
          "api-key": process.env.BREVO_API_KEY,
          "content-type": "application/json"
        },

        body: JSON.stringify({
          sender: {
            email: process.env.SENDER_EMAIL,
            name: "Survey Team"
          },

          to: [
            {
              email: toEmail
            }
          ],

          subject: "Survey Participation Confirmation",

          htmlContent: `
            <h3>Hello,</h3>

            <p>
              Thank you for participating
              in our survey.
            </p>

            <p>
              Your 6-digit confirmation code is:
            </p>

            <h2>${code}</h2>

            <p>
              Please share this code
              with our team member only.
            </p>
          `
        })
      }
    );

    if (!response.ok) {
      const errorText = await response.text();

      console.error("BREVO ERROR:", errorText);

      return false;
    }

    console.log("Mail sent to:", toEmail);

    return true;

  } catch (error) {
    console.error("MAIL ERROR:", error);

    return false;
  }
}

// ==========================================
// ADMIN: GET ALL SURVEYS
// ==========================================

app.get(
  "/admin/surveys",
  requireAdmin,
  async (req, res) => {
    try {
      const result = await pool.query(`
        SELECT
          id,
          name,
          email,
          survey_code AS "surveyCode",
          status,
          created_at AS "createdAt"
        FROM surveys
        ORDER BY id DESC
      `);

      res.json(result.rows);

    } catch (error) {
      console.error("ADMIN LIST ERROR:", error);

      res.status(500).json({
        msg: "Failed to load surveys"
      });
    }
  }
);

// ==========================================
// ADMIN: SEND EMAIL
// EXISTING FUNCTIONALITY
// ==========================================

app.post(
  "/send-email/:id",
  requireAdmin,
  async (req, res) => {
    try {
      const id = Number(req.params.id);

      if (!Number.isInteger(id) || id <= 0) {
        return res.status(400).json({
          msg: "Invalid survey ID"
        });
      }

      const result = await pool.query(
        `SELECT id, email, status, survey_code
         FROM surveys
         WHERE id = $1`,
        [id]
      );

      if (result.rows.length === 0) {
        return res.status(404).json({
          msg: "Survey not found"
        });
      }

      const survey = result.rows[0];

      if (
        survey.status === "active" &&
        survey.survey_code
      ) {
        return res.status(400).json({
          msg: "Email has already been sent"
        });
      }

      const code = crypto
        .randomInt(100000, 1000000)
        .toString();

      const mailSent = await sendApprovalMail(
        survey.email,
        code
      );

      if (!mailSent) {
        return res.status(500).json({
          msg: "Email could not be sent. Code was not saved."
        });
      }

      await pool.query(
        `UPDATE surveys
         SET status = $1,
             survey_code = $2
         WHERE id = $3`,
        ["active", code, id]
      );

      res.json({
        msg: "Email sent successfully",
        surveyCode: code
      });

    } catch (error) {
      console.error("SEND EMAIL ERROR:", error);

      res.status(500).json({
        msg: "Failed to send email"
      });
    }
  }
);

// ==========================================
// ADMIN: DELETE SURVEY
// ==========================================

app.delete(
  "/delete-survey/:id",
  requireAdmin,
  async (req, res) => {
    try {
      const id = Number(req.params.id);

      if (!Number.isInteger(id) || id <= 0) {
        return res.status(400).json({
          msg: "Invalid survey ID"
        });
      }

      const result = await pool.query(
        `DELETE FROM surveys
         WHERE id = $1
         RETURNING id`,
        [id]
      );

      if (result.rows.length === 0) {
        return res.status(404).json({
          msg: "Survey not found"
        });
      }

      res.json({
        msg: "Deleted successfully"
      });

    } catch (error) {
      console.error("DELETE ERROR:", error);

      res.status(500).json({
        msg: "Delete error"
      });
    }
  }
);

// ==========================================
// ADMIN: ANALYTICS
// ==========================================

app.get(
  "/analytics",
  requireAdmin,
  async (req, res) => {
    try {
      const result = await pool.query(
        `SELECT answers FROM surveys`
      );

      const rows = result.rows;
      const total = rows.length;

      const usage = {
        low: 0,
        medium: 0,
        high: 0
      };

      const purpose = {
        entertainment: 0,
        education: 0,
        business: 0,
        chatting: 0
      };

      let addictionYes = 0;
      let mentalNegative = 0;

      rows.forEach((row) => {
        const answers = row.answers || {};

        if (answers.q0 === "5+ hours") {
          usage.high++;

        } else if (answers.q0 === "3–5 hours") {
          usage.medium++;

        } else {
          usage.low++;
        }

        if (answers.q1 === "Entertainment") {
          purpose.entertainment++;
        }

        if (answers.q1 === "Education") {
          purpose.education++;
        }

        if (answers.q1 === "Business") {
          purpose.business++;
        }

        if (answers.q1 === "Chatting") {
          purpose.chatting++;
        }

        if (answers.q4 === "Yes") {
          addictionYes++;
        }

        if (answers.q3 === "Negative") {
          mentalNegative++;
        }
      });

      res.json({
        summary: [
          {
            label: "Total Surveys",
            value: total
          },
          {
            label: "Addiction %",
            value: total
              ? ((addictionYes / total) * 100).toFixed(1)
              : "0.0"
          },
          {
            label: "Mental Negative %",
            value: total
              ? ((mentalNegative / total) * 100).toFixed(1)
              : "0.0"
          }
        ],

        usage,
        purpose
      });

    } catch (error) {
      console.error("ANALYTICS ERROR:", error);

      res.status(500).json({
        msg: "Failed to load analytics"
      });
    }
  }
);

// ==========================================
// PROTECT ADMIN DASHBOARD PAGE
// ==========================================

app.get("/admin.html", (req, res) => {
  if (req.session?.isAdmin !== true) {
    return res.redirect("/confirmation.html");
  }

  res.sendFile(
    path.join(__dirname, "public", "admin.html")
  );
});

// ==========================================
// STATIC FILES
// KEEP THIS AFTER PROTECTED ROUTES
// ==========================================

app.use(
  express.static(
    path.join(__dirname, "public")
  )
);

// ==========================================
// START SERVER
// ==========================================

const PORT = process.env.PORT || 5000;

async function startServer() {
  try {
    await pool.query("SELECT NOW()");

    console.log("PostgreSQL connected successfully");
    const dbCheck = await pool.query(`
  SELECT current_database() AS database,
         current_schema() AS schema,
         to_regclass('public.login_requests') AS table_name
`);

console.log("DATABASE CHECK:", dbCheck.rows[0]);

    await createTable();
    

    app.listen(PORT, () => {
      console.log(`Server running on port ${PORT}`);
    });

  } catch (error) {
    console.error("SERVER START ERROR:", error);

    process.exit(1);
  }
}

startServer();