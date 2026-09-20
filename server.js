// ==========================================
// IMPORTS
// ==========================================

require("dotenv").config();

const express = require("express");
const { Pool } = require("pg");
const path = require("path");


// ==========================================
// APP SETUP
// ==========================================

const app = express();

app.use(express.json());

app.use(
  express.static(
    path.join(__dirname, "public")
  )
);


// ==========================================
// POSTGRESQL DATABASE
// ==========================================

const pool = new Pool({
  host: process.env.PGHOST || "localhost",
  port: process.env.PGPORT || 5432,
  user: process.env.PGUSER || "postgres",
  password: process.env.PGPASSWORD,
  database: process.env.PGDATABASE || "survey_db"
});


// ==========================================
// TEST DATABASE CONNECTION
// ==========================================

pool
  .query("SELECT NOW()")
  .then(() => {
    console.log("PostgreSQL connected successfully");
  })
  .catch((error) => {
    console.error(
      "PostgreSQL connection error:",
      error
    );
  });


// ==========================================
// CREATE TABLE
// ==========================================

async function createTable() {

  try {

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

    console.log("Surveys table ready");

  } catch (error) {

    console.error(
      "TABLE CREATION ERROR:",
      error
    );

  }

}


// ==========================================
// BREVO MAIL FUNCTION
// ==========================================

async function sendApprovalMail(
  toEmail,
  code
) {

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

          subject:
            "Survey Participation Confirmation",

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

      const errorText =
        await response.text();

      console.error(
        "BREVO ERROR:",
        errorText
      );

      return false;
    }


    console.log(
      "Mail sent to:",
      toEmail
    );

    return true;


  } catch (error) {

    console.error(
      "MAIL ERROR:",
      error
    );

    return false;
  }

}


// ==========================================
// SUBMIT SURVEY
// ==========================================

app.post(
  "/submit-survey",
  async (req, res) => {

    try {

      const {
        name,
        email,
        answers
      } = req.body;


      console.log(
        "SUBMIT REQUEST:",
        req.body
      );


      // Validate data
      if (
        !name ||
        !email ||
        !answers ||
        typeof answers !== "object"
      ) {

        return res.status(400).json({
          msg: "Missing survey data"
        });

      }


      // Save survey as pending.
      // Code is NOT generated here.

      const result = await pool.query(

        `
        INSERT INTO surveys
        (
          name,
          email,
          answers,
          status
        )

        VALUES
        ($1, $2, $3, $4)

        RETURNING id
        `,

        [
          name,
          email,
          answers,
          "pending"
        ]

      );


      console.log(
        "SURVEY SAVED:",
        result.rows[0].id
      );


      res.status(201).json({

        msg:
          "Thank you for participating in our survey!",

        surveyId:
          result.rows[0].id

      });


    } catch (error) {

      console.error(
        "SUBMIT DATABASE ERROR:",
        error
      );


      res.status(500).json({
        msg: "Failed to save survey"
      });

    }

  }
);


// ==========================================
// ADMIN - GET ALL SURVEYS
// ==========================================

app.get(
  "/admin/surveys",
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

      console.error(
        "ADMIN LIST ERROR:",
        error
      );


      res.status(500).json({
        msg: "Failed to load surveys"
      });

    }

  }
);


// ==========================================
// ADMIN - SEND EMAIL
// ==========================================

app.post(
  "/send-email/:id",
  async (req, res) => {

    try {

      const id =
        req.params.id;


      // Find survey
      const result =
        await pool.query(

          `
          SELECT
            id,
            email,
            status,
            survey_code
          FROM surveys

          WHERE id = $1
          `,

          [id]

        );


      if (
        result.rows.length === 0
      ) {

        return res.status(404).json({
          msg: "Survey not found"
        });

      }


      const survey =
        result.rows[0];


      // Prevent sending multiple codes
      if (
        survey.status === "active" &&
        survey.survey_code
      ) {

        return res.status(400).json({
          msg: "Email has already been sent"
        });

      }


      // ==================================
      // GENERATE 6-DIGIT CODE
      // ==================================

      const code =
        Math.floor(
          100000 +
          Math.random() * 900000
        ).toString();


      // ==================================
      // SEND EMAIL FIRST
      // ==================================

      const mailSent =
        await sendApprovalMail(
          survey.email,
          code
        );


      if (!mailSent) {

        return res.status(500).json({

          msg:
            "Email could not be sent. Code was not saved."

        });

      }


      // ==================================
      // SAVE CODE AFTER EMAIL SUCCESS
      // ==================================

      await pool.query(

        `
        UPDATE surveys

        SET
          status = $1,
          survey_code = $2

        WHERE id = $3
        `,

        [
          "active",
          code,
          id
        ]

      );


      // ==================================
      // SUCCESS
      // ==================================

      res.json({

        msg:
          "Email sent successfully",

        surveyCode:
          code

      });


    } catch (error) {

      console.error(
        "SEND EMAIL ERROR:",
        error
      );


      res.status(500).json({
        msg: "Failed to send email"
      });

    }

  }
);


// ==========================================
// DELETE SURVEY
// ==========================================

app.delete(
  "/delete-survey/:id",
  async (req, res) => {

    try {

      const id =
        req.params.id;


      const result =
        await pool.query(

          `
          DELETE FROM surveys

          WHERE id = $1

          RETURNING id
          `,

          [id]

        );


      if (
        result.rows.length === 0
      ) {

        return res.status(404).json({
          msg: "Survey not found"
        });

      }


      res.json({
        msg: "Deleted successfully"
      });


    } catch (error) {

      console.error(
        "DELETE ERROR:",
        error
      );


      res.status(500).json({
        msg: "Delete error"
      });

    }

  }
);


// ==========================================
// ANALYTICS
// ==========================================

app.get(
  "/analytics",
  async (req, res) => {

    try {

      const result =
        await pool.query(`

          SELECT
            answers

          FROM surveys

        `);


      const rows =
        result.rows;


      const total =
        rows.length;


      let usage = {
        low: 0,
        medium: 0,
        high: 0
      };


      let purpose = {
        entertainment: 0,
        education: 0,
        business: 0,
        chatting: 0
      };


      let addictionYes =
        0;


      let mentalNegative =
        0;


      // ==================================
      // PROCESS ANSWERS
      // ==================================

      rows.forEach(row => {

        const answers =
          row.answers;


        // Question 1
        if (
          answers.q0 === "5+ hours"
        ) {

          usage.high++;

        } else if (
          answers.q0 === "3–5 hours"
        ) {

          usage.medium++;

        } else {

          usage.low++;

        }


        // Question 2
        if (
          answers.q1 === "Entertainment"
        ) {

          purpose.entertainment++;

        }


        if (
          answers.q1 === "Education"
        ) {

          purpose.education++;

        }


        if (
          answers.q1 === "Business"
        ) {

          purpose.business++;

        }


        if (
          answers.q1 === "Chatting"
        ) {

          purpose.chatting++;

        }


        // Question 5
        if (
          answers.q4 === "Yes"
        ) {

          addictionYes++;

        }


        // Question 4
        if (
          answers.q3 === "Negative"
        ) {

          mentalNegative++;

        }

      });


      // ==================================
      // SEND ANALYTICS
      // ==================================

      res.json({

        summary: [

          {
            label:
              "Total Surveys",

            value:
              total
          },

          {
            label:
              "Addiction %",

            value:
              total
                ? (
                    (addictionYes / total)
                    * 100
                  ).toFixed(1)
                : "0.0"
          },

          {
            label:
              "Mental Negative %",

            value:
              total
                ? (
                    (mentalNegative / total)
                    * 100
                  ).toFixed(1)
                : "0.0"
          }

        ],

        usage,

        purpose

      });


    } catch (error) {

      console.error(
        "ANALYTICS ERROR:",
        error
      );


      res.status(500).json({
        msg: "Failed to load analytics"
      });

    }

  }
);


// ==========================================
// START SERVER
// ==========================================

const PORT =
  process.env.PORT || 5000;


async function startServer() {

  await createTable();


  app.listen(
    PORT,
    () => {

      console.log(
        `Server running on port ${PORT}`
      );

    }
  );

}


startServer();
