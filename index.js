const express = require("express");
const Anthropic = require("@anthropic-ai/sdk");
const path = require("path");
const https = require("https");
const session = require("express-session");
const passport = require("passport");
const GoogleStrategy = require("passport-google-oauth20").Strategy;

const app = express();
app.set("trust proxy", 1);
app.use(express.json());

// ─── Session & Passport ───────────────────────────────────────────────────────
app.use(session({
  secret: process.env.SESSION_SECRET || "rr-secret-fallback",
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === "production",
    maxAge: 7 * 24 * 60 * 60 * 1000
  }
}));

app.use(passport.initialize());
app.use(passport.session());

passport.use(new GoogleStrategy({
  clientID: process.env.GOOGLE_CLIENT_ID,
  clientSecret: process.env.GOOGLE_CLIENT_SECRET,
  callbackURL: process.env.GOOGLE_CALLBACK_URL || "/auth/google/callback"
}, (accessToken, refreshToken, profile, done) => {
  const user = {
    id: profile.id,
    name: profile.displayName,
    email: profile.emails?.[0]?.value || "",
    picture: profile.photos?.[0]?.value || "",
    accessToken
  };
  return done(null, user);
}));

passport.serializeUser((user, done) => done(null, user));
passport.deserializeUser((user, done) => done(null, user));

// ─── Auth Middleware ──────────────────────────────────────────────────────────
function isAuthenticated(req, res, next) {
  if (req.isAuthenticated()) return next();
  res.redirect("/");
}

// ─── Anthropic & Config ───────────────────────────────────────────────────────
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const ADMIN_PASSWORD       = process.env.ADMIN_PASSWORD;
const GITHUB_TOKEN         = process.env.GITHUB_TOKEN;
const GITHUB_REPO          = process.env.GITHUB_REPO;
const GOOGLE_PLACES_API_KEY = process.env.GOOGLE_PLACES_API_KEY;

// ─── Generic HTTPS GET Helper ─────────────────────────────────────────────────
function httpsGet(hostname, apiPath) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname,
      path: apiPath,
      method: "GET",
      headers: { "Accept": "application/json" }
    };
    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", chunk => data += chunk);
      res.on("end", () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(e); }
      });
    });
    req.on("error", reject);
    req.end();
  });
}

// ─── GitHub Password Store ────────────────────────────────────────────────────
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
        } catch (e) { reject(e); }
      });
    });
    req.on("error", reject);
    req.end();
  });
}

async function savePasswords(clients, sha) {
  return new Promise((resolve, reject) => {
    const content = Buffer.from(JSON.stringify(clients, null, 2)).toString("base64");
    const body = JSON.stringify({ message: "Update passwords", content, sha });
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

function randomString() {
  return Math.random().toString(36).substring(2, 6);
}

// ─── Page Routes ──────────────────────────────────────────────────────────────
app.get("/", (req, res) => {
  if (req.isAuthenticated()) return res.redirect("/app");
  res.sendFile(path.join(__dirname, "public", "login.html"));
});

app.get("/app", isAuthenticated, (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.get("/admin", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "admin.html"));
});

// ─── Google OAuth Routes ──────────────────────────────────────────────────────
app.get("/auth/google",
  passport.authenticate("google", {
    scope: ["profile", "email"],
    accessType: "online"
  })
);

app.get("/auth/google/callback",
  passport.authenticate("google", { failureRedirect: "/?error=auth_failed" }),
  (req, res) => res.redirect("/app")
);

app.get("/auth/logout", (req, res, next) => {
  req.logout((err) => {
    if (err) return next(err);
    req.session.destroy(() => res.redirect("/"));
  });
});

app.get("/me", isAuthenticated, (req, res) => {
  res.json({ name: req.user.name, email: req.user.email, picture: req.user.picture });
});

// ─── Places: Search Businesses ────────────────────────────────────────────────
app.get("/places/search", isAuthenticated, async (req, res) => {
  const { query } = req.query;
  if (!query) return res.status(400).json({ error: "query is required" });

  try {
    const encoded = encodeURIComponent(query);
    const data = await httpsGet(
      "maps.googleapis.com",
      `/maps/api/place/textsearch/json?query=${encoded}&key=${GOOGLE_PLACES_API_KEY}`
    );

    if (data.status !== "OK" && data.status !== "ZERO_RESULTS") {
      return res.status(500).json({ error: data.error_message || data.status });
    }

    const places = (data.results || []).slice(0, 6).map(p => ({
      placeId: p.place_id,
      name: p.name,
      address: p.formatted_address,
      rating: p.rating,
      totalRatings: p.user_ratings_total
    }));

    res.json({ places });
  } catch (e) {
    console.error("Places search error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─── Places: Get Reviews ──────────────────────────────────────────────────────
app.get("/places/reviews", isAuthenticated, async (req, res) => {
  const { placeId } = req.query;
  if (!placeId) return res.status(400).json({ error: "placeId is required" });

  try {
    const data = await httpsGet(
      "maps.googleapis.com",
      `/maps/api/place/details/json?place_id=${placeId}&fields=name,rating,reviews&key=${GOOGLE_PLACES_API_KEY}`
    );

    if (data.status !== "OK") {
      return res.status(500).json({ error: data.error_message || data.status });
    }

    const result = data.result || {};
    res.json({
      name: result.name,
      rating: result.rating,
      reviews: (result.reviews || []).map(r => ({
        author: r.author_name,
        rating: r.rating,
        text: r.text,
        time: r.relative_time_description
      }))
    });
  } catch (e) {
    console.error("Places reviews error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─── Legacy Password Auth ─────────────────────────────────────────────────────
app.post("/verify", async (req, res) => {
  const { password } = req.body;
  try {
    const { clients } = await getPasswords();
    const client = clients.find(c => c.active && c.currentPassword === password);
    if (client) res.json({ success: true, clientName: client.client });
    else res.json({ success: false, error: "Invalid password. Please contact support." });
  } catch (e) {
    res.status(500).json({ success: false, error: "Server error. Try again." });
  }
});

// ─── Admin Routes ─────────────────────────────────────────────────────────────
app.post("/admin/verify", (req, res) => {
  const { password } = req.body;
  if (password === ADMIN_PASSWORD) res.json({ success: true });
  else res.json({ success: false, error: "Invalid admin password." });
});

app.post("/admin/clients", async (req, res) => {
  const { adminPassword } = req.body;
  if (adminPassword !== ADMIN_PASSWORD) return res.status(401).json({ error: "Unauthorized" });
  try {
    const { clients } = await getPasswords();
    res.json({ clients });
  } catch (e) { res.status(500).json({ error: "Could not load clients." }); }
});

app.post("/admin/add", async (req, res) => {
  const { adminPassword, client, password } = req.body;
  if (adminPassword !== ADMIN_PASSWORD) return res.status(401).json({ error: "Unauthorized" });
  try {
    const { clients, sha } = await getPasswords();
    const newId = clients.length > 0 ? Math.max(...clients.map(c => c.id)) + 1 : 1;
    clients.push({ id: newId, client, password, currentPassword: password, active: true });
    await savePasswords(clients, sha);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: "Could not add client." }); }
});

app.post("/admin/reset", async (req, res) => {
  const { adminPassword, id, newPassword } = req.body;
  if (adminPassword !== ADMIN_PASSWORD) return res.status(401).json({ error: "Unauthorized" });
  if (!newPassword || newPassword.trim().length < 4)
    return res.status(400).json({ error: "Password must be at least 4 characters." });
  try {
    const { clients, sha } = await getPasswords();
    const client = clients.find(c => c.id === id);
    if (!client) return res.status(404).json({ error: "Client not found." });
    client.password = newPassword.trim();
    client.currentPassword = newPassword.trim();
    await savePasswords(clients, sha);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: "Could not reset password." }); }
});

app.post("/admin/toggle", async (req, res) => {
  const { adminPassword, id } = req.body;
  if (adminPassword !== ADMIN_PASSWORD) return res.status(401).json({ error: "Unauthorized" });
  try {
    const { clients, sha } = await getPasswords();
    const client = clients.find(c => c.id === id);
    if (!client) return res.status(404).json({ error: "Client not found." });
    if (client.active) {
      client.active = false;
      client.currentPassword = randomString();
    } else {
      client.active = true;
      client.currentPassword = client.password;
    }
    await savePasswords(clients, sha);
    res.json({ success: true, client });
  } catch (e) { res.status(500).json({ error: "Could not update client." }); }
});

// ─── Generate Review Response ─────────────────────────────────────────────────
app.post("/generate", isAuthenticated, async (req, res) => {
  const { businessName, businessType, review, tone, stars } = req.body;
  if (!businessName || !review)
    return res.status(400).json({ error: "Business name and review are required." });

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
      messages: [{ role: "user", content: prompt }]
    });
    const text = message.content
      .filter(b => b.type === "text")
      .map(b => b.text)
      .join("");
    res.json({ response: text.trim() });
  } catch (error) {
    console.error("Anthropic error:", error.message);
    res.status(500).json({ error: "Failed to generate response." });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Review Responder running on port ${PORT}`));
