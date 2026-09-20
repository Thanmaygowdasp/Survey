// ==============================
// GET USER DETAILS
// ==============================

const name = localStorage.getItem("name");
const email = localStorage.getItem("email");

if (!name || !email) {
  alert("Enter your details first.");
  window.location.href = "/";
}


// ==============================
// SHOW WELCOME MESSAGE
// ==============================

const welcome = document.getElementById("welcome");

if (welcome) {
  welcome.innerText = `Welcome ${name} (${email})`;
}


// ==============================
// SURVEY QUESTIONS
// ==============================

const questions = [
  {
    q: "How often do you use Instagram?",
    options: ["< 1 hour", "1–3 hours", "3–5 hours", "5+ hours"]
  },

  {
    q: "Main purpose of Instagram?",
    options: ["Entertainment", "Education", "Business", "Chatting"]
  },

  {
    q: "Does Instagram waste your time?",
    options: ["Yes", "Sometimes", "No"]
  },

  {
    q: "Mental health impact?",
    options: ["Positive", "Neutral", "Negative"]
  },

  {
    q: "Do you feel addicted?",
    options: ["Yes", "No", "Sometimes"]
  },

  {
    q: "Content you see most?",
    options: ["Reels", "Memes", "Education", "Influencers"]
  },

  {
    q: "Productivity impact?",
    options: ["High negative", "Moderate", "Low", "No effect"]
  },

  {
    q: "Do you compare your life?",
    options: ["Often", "Sometimes", "Never"]
  },

  {
    q: "Overall Instagram effect?",
    options: ["Positive", "Balanced", "Negative"]
  },

  {
    q: "Final opinion?",
    options: ["Good platform", "Neutral", "Bad influence"]
  }
];


// ==============================
// RENDER QUESTIONS
// ==============================

const questionsContainer =
  document.getElementById("questions");


questions.forEach((question, index) => {

  const questionBox =
    document.createElement("div");

  questionBox.style.marginBottom = "20px";


  questionBox.innerHTML = `
    <p>
      <b>${index + 1}. ${question.q}</b>
    </p>

    ${question.options
      .map(
        option => `
          <label>

            <input
              type="radio"
              name="q${index}"
              value="${option}"
              required
            />

            ${option}

          </label>

          <br />
        `
      )
      .join("")}
  `;


  questionsContainer.appendChild(
    questionBox
  );

});


// ==============================
// SUBMIT SURVEY
// ==============================

const surveyForm =
  document.getElementById("surveyForm");


surveyForm.addEventListener(
  "submit",
  async (event) => {

    event.preventDefault();


    // ==========================
    // COLLECT ANSWERS
    // ==========================

    const formData =
      new FormData(surveyForm);

    const answers = {};


    formData.forEach(
      (value, key) => {
        answers[key] = value;
      }
    );


    try {

      // ========================
      // SEND TO SERVER
      // ========================

      const response =
        await fetch(
          "/submit-survey",
          {
            method: "POST",

            headers: {
              "Content-Type":
                "application/json"
            },

            body: JSON.stringify({
              name,
              email,
              answers
            })
          }
        );


      const data =
        await response.json();


      // ========================
      // CHECK RESPONSE
      // ========================

      if (!response.ok) {

        throw new Error(
          data.msg ||
          "Server error"
        );

      }


      // ========================
      // SUCCESS
      // ========================

      alert(
        "Thank you for participating in our survey!"
      );


      // ========================
      // CLEAR USER DATA
      // ========================

      localStorage.clear();


      // ========================
      // RETURN HOME
      // ========================

      window.location.href = "/";


    } catch (error) {

      console.error(
        "SUBMIT ERROR:",
        error
      );


      alert(
        "Survey submission failed.\n\n" +
        error.message
      );

    }

  }
);
