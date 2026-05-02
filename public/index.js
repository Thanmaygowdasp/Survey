// Get user details
const name = localStorage.getItem('name');
const email = localStorage.getItem('email');

if (!name || !email) {
  alert("Enter details first");
  window.location.href = "/";
}

// Show welcome
document.getElementById('welcome').innerText =
  "Welcome " + name + " (" + email + ")";

// Questions list
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

// Render questions
const qDiv = document.getElementById('questions');

questions.forEach((item, i) => {
  qDiv.innerHTML += `
    <div style="margin-bottom:20px;">
      <p><b>${item.q}</b></p>
      ${item.options.map(opt => `
        <label>
          <input type="radio" name="q${i}" value="${opt}" required />
          ${opt}
        </label><br/>
      `).join('')}
    </div>
  `;
});

// Submit survey
document.getElementById('surveyForm').addEventListener('submit', (e) => {
  e.preventDefault();

  const formData = new FormData(e.target);
  const answers = {};

  formData.forEach((v, k) => answers[k] = v);

  fetch('/submit-survey', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, email, answers })
  })
  .then(res => res.json())
  .then(data => {
    alert(`${data.msg}\nSurvey Code: ${data.surveyCode}`);
    localStorage.clear();
    window.location.href = "/";
  });
});