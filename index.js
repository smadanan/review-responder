const express = require("express");
const Anthropic = require("@anthropic-ai/sdk");
const path = require("path");
const https = require("https");

const app = express();
app.use(express.json());

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_REPO = process.env.GITHUB_REPO;

// Fetch passwords from GitHub
async function getPasswords() {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: "api.github.com",
      path: `/repos/${GITHUB_REPO}/contents/passwords.json`,
      method: "GET",
      headers: {
        "Authorization": `Bearer ${GITHUB_TOKEN}`,
        "User-Agent": "review-responder",
        "Accept": "application/vnd.github.v3+json"
      }
    };
    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", chunk => data += chunk);
      res.on("end", () => {
        try {
          const parsed = JSON.parse(data);
          const content = Buffer.from(parsed.content, "base64").toString("utf8");
          resolve({ clients: JSON.parse(content), sha: parsed.sha });
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on("error", reject);
    req.end();
  });
}

// Save passwords to GitHub
async function savePasswords(clients, sha) {
  return new Promise((resolve, reject) => {
    const content = Buffer.from(JSON.stringify(clients, null, 2)).toString("base64");
    const body = JSON.stringify({
      message: "Update passwords",
      content,
      sha
    });
    const options = {
      hostname: "api.github.com",
      path: `/repos/${GITHUB_REPO}/contents/passwords.json`,
      method: "PUT",
      headers: {
        "Authorization": `Bearer ${GITHUB_TOKEN}`,
        "User-Agent": "review-responder",
        "Accept": "application/vnd.github.v3+json",
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body)
      }
    };
    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", chunk => data += chunk);
      res.on("end", () => resolve(JSON.parse(data)));
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

// Generate random 4 letter string
function randomString() {
  return Math.random().toString(36).substring(2, 6);
}

// Serve login page
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "login.html"));
});

// Serve main app
app.get("/app", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// Serve admin page
app.get("/admin", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "admin.html"));
});

// Verify client password
app.post("/verify", async (req, res) => {
  const { password } = req.body;
  try {
    const { clients } = await getPasswords();
    const client = clients.find(c => c.active && c.currentPassword === password);
    if (client) {
      res.json({ success: true, clientName: client.client });
    } else {
      res.json({ success: false, error: "Invalid password. Please contact support." });
    }
  } catch (e) {
    res.status(500).json({ success: false, error: "Server error. Try again." });
  }
});

// Verify admin password
app.post("/admin/verify", (req, res) => {
  const { password } = req.body;
  if (password === ADMIN_PASSWORD) {
    res.json({ success: true });
  } else {
    res.json({ success: false, error: "Invalid admin password." });
  }
});

// Get all clients
app.post("/admin/clients", async (req, res) => {
  const { adminPassword } = req.body;
  if (adminPassword !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  try {
    const { clients } = await getPasswords();
    res.json({ clients });
  } catch (e) {
    res.status(500).json({ error: "Could not load clients." });
  }
});

// Add new client
app.post("/admin/add", async (req, res) => {
  const { adminPassword, client, password } = req.body;
  if (adminPassword !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  try {
    const { clients, sha } = await getPasswords();
    const newId = clients.length > 0 ? Math.max(...clients.map(c => c.id)) + 1 : 1;
    clients.push({
      id: newId,
      client,
      password,
      currentPassword: password,
      active: true
    });
    await savePasswords(clients, sha);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: "Could not add client." });
  }
});

// Toggle client active/inactive
app.post("/admin/toggle", async (req, res) => {
  const { adminPassword, id } = req.body;
  if (adminPassword !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  try {
    const { clients, sha } = await getPasswords();
    const client = clients.find(c => c.id === id);
    if (!client) return res.status(404).json({ error: "Client not found." });

    if (client.active) {
      // Deactivate — replace password with random string
      client.active = false;
      client.currentPassword = randomString();
    } else {
      // Reactivate — restore original password
      client.active = true;
      client.currentPassword = client.password;
    }

    await savePasswords(clients, sha);
    res.json({ success: true, client });
  } catch (e) {
    res.status(500).json({ error: "Could not update client." });
  }
});

// Generate review response
app.post("/generate", async (req, res) => {
  const { businessName, businessType, review, tone, stars, password } = req.body;

  try {
    const { clients } = await getPasswords();
    const validClient = clients.find(c => c.active && c.currentPassword === password);
    if (!validClient) {
      return res.status(401).json({ error: "Unauthorized. Please log in again." });
    }
  } catch (e) {
    return res.status(500).json({ error: "Server error. Try again." });
  }

  if (!businessName || !review) {
    return res.status(400).json({ error: "Business name and review are required." });
  }

  const starLabel = stars > 0 ? `${stars}-star` : "unrated";
  const prompt = `You are a professional reputation manager for a ${businessType} called "${businessName}".

A customer left this ${starLabel} review:
"${review}"

Write a ${tone.toLowerCase()} response to this review. Follow these rules:
- Keep it between 60 to 120 words
- Thank the customer naturally
- Address specific points they raised
- If the review is negative, acknowledge the issue sincerely and offer to make it right
- Do NOT use hollow phrases like "We value your feedback"
- End with a warm, forward-looking closing
- Write only the response text, no subject line or label`;

  try {
    const message = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 300,
      messages: [{ role: "user", content: prompt }],
    });

    const text = message.content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("");

    res.json({ response: text.trim() });
  } catch (error) {
    console.error("Anthropic error:", error.message);
    res.status(500).json({ error: "Failed to generate response." });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Review Responder running on port ${PORT}`);
});
