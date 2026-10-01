require("dotenv").config();

const fs = require("fs");
const path = require("path");
const express = require("express");
const cors = require("cors");
const rateLimit = require("express-rate-limit");
const cron = require("node-cron");
const Database = require("better-sqlite3");
const nodemailer = require("nodemailer");
const webpush = require("web-push");

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const TIMEZONE = "Asia/Kolkata";
const CHECKPOINTS = [7, 3, 2, 1, 0];
const DB_PATH = path.resolve(process.cwd(), process.env.DB_PATH || "./data/docutrack.db");
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "";
const SMTP_HOST = process.env.SMTP_HOST || "";
const SMTP_PORT = Number(process.env.SMTP_PORT || 587);
const SMTP_USER = process.env.SMTP_USER || "";
const SMTP_PASS = process.env.SMTP_PASS || "";
const MAIL_FROM = process.env.MAIL_FROM || "";

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.exec(`
	CREATE TABLE IF NOT EXISTS users (
		owner_id TEXT PRIMARY KEY,
		email TEXT NOT NULL,
		email_enabled INTEGER NOT NULL DEFAULT 0
	);

	CREATE TABLE IF NOT EXISTS documents (
		owner_id TEXT NOT NULL,
		doc_id TEXT NOT NULL,
		name TEXT NOT NULL,
		category TEXT NOT NULL,
		expiry_date TEXT NOT NULL,
		PRIMARY KEY (owner_id, doc_id)
	);

	CREATE TABLE IF NOT EXISTS sent_reminders (
		owner_id TEXT NOT NULL,
		doc_id TEXT NOT NULL,
		expiry_date TEXT NOT NULL,
		checkpoint INTEGER NOT NULL,
		sent_at TEXT NOT NULL,
		PRIMARY KEY (owner_id, doc_id, expiry_date, checkpoint)
	);

	CREATE TABLE IF NOT EXISTS subscriptions (
		owner_id TEXT PRIMARY KEY,
		subscription_json TEXT NOT NULL
	);
`);

const upsertUserStmt = db.prepare(
	`INSERT INTO users (owner_id, email, email_enabled)
	 VALUES (@ownerId, @email, @emailEnabled)
	 ON CONFLICT(owner_id) DO UPDATE SET
		 email = excluded.email,
		 email_enabled = excluded.email_enabled`
);
const deleteUserStmt = db.prepare(`DELETE FROM users WHERE owner_id = ?`);
const deleteOwnerDocsStmt = db.prepare(`DELETE FROM documents WHERE owner_id = ?`);
const insertDocStmt = db.prepare(
	`INSERT INTO documents (owner_id, doc_id, name, category, expiry_date)
	 VALUES (@ownerId, @docId, @name, @category, @expiryDate)`
);
const dueDocsStmt = db.prepare(
	`SELECT
		 d.owner_id AS ownerId,
		 d.doc_id AS docId,
		 d.name,
		 d.category,
		 d.expiry_date AS expiryDate,
		 u.email,
		 u.email_enabled AS emailEnabled,
		 s.subscription_json AS subscriptionJson
	 FROM documents d
	 LEFT JOIN users u ON u.owner_id = d.owner_id
	 LEFT JOIN subscriptions s ON s.owner_id = d.owner_id`
);
const reminderExistsStmt = db.prepare(
	`SELECT 1 FROM sent_reminders
	 WHERE owner_id = ? AND doc_id = ? AND expiry_date = ? AND checkpoint = ?
	 LIMIT 1`
);
const insertReminderStmt = db.prepare(
	`INSERT INTO sent_reminders (owner_id, doc_id, expiry_date, checkpoint, sent_at)
	 VALUES (?, ?, ?, ?, ?)`
);
const upsertSubscriptionStmt = db.prepare(
	`INSERT INTO subscriptions (owner_id, subscription_json)
	 VALUES (?, ?)
	 ON CONFLICT(owner_id) DO UPDATE SET subscription_json = excluded.subscription_json`
);
const deleteSubscriptionStmt = db.prepare(`DELETE FROM subscriptions WHERE owner_id = ?`);
const getSubscriptionStmt = db.prepare(`SELECT subscription_json FROM subscriptions WHERE owner_id = ?`);
const getUserStmt = db.prepare(`SELECT owner_id, email, email_enabled FROM users WHERE owner_id = ?`);

if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY && process.env.VAPID_SUBJECT) {
	webpush.setVapidDetails(
		process.env.VAPID_SUBJECT,
		process.env.VAPID_PUBLIC_KEY,
		process.env.VAPID_PRIVATE_KEY
	);
}

const transporter = SMTP_HOST && MAIL_FROM
	? nodemailer.createTransport({
			host: SMTP_HOST,
			port: SMTP_PORT,
			secure: SMTP_PORT === 465,
			auth: SMTP_USER || SMTP_PASS ? { user: SMTP_USER, pass: SMTP_PASS } : undefined,
		})
	: null;

const corsOptions = {
	origin(origin, callback) {
		if (!origin || (ALLOWED_ORIGIN && origin === ALLOWED_ORIGIN)) {
			callback(null, true);
			return;
		}

		callback(new Error("CORS blocked"));
	},
};

const mutationLimiter = rateLimit({
	windowMs: 15 * 60 * 1000,
	limit: 120,
	standardHeaders: true,
	legacyHeaders: false,
});

app.disable("x-powered-by");
app.use(cors(corsOptions));
app.options("*", cors(corsOptions));
app.use(express.json({ limit: "200kb" }));
app.use((req, res, next) => {
	if (req.method === "POST" || req.method === "DELETE") {
		return mutationLimiter(req, res, next);
	}

	return next();
});

function escapeHtml(value) {
	return String(value ?? "").replace(/[&<>"']/g, (char) => {
		switch (char) {
			case "&": return "&amp;";
			case "<": return "&lt;";
			case ">": return "&gt;";
			case '"': return "&quot;";
			case "'": return "&#39;";
			default: return char;
		}
	});
}

function getIstDateString(date = new Date()) {
	const parts = new Intl.DateTimeFormat("en-CA", {
		timeZone: TIMEZONE,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
	}).formatToParts(date);
	const map = Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
	return `${map.year}-${map.month}-${map.day}`;
}

function daysLeftInIst(expiryDate) {
	const today = new Date(`${getIstDateString()}T00:00:00Z`);
	const expiry = new Date(`${expiryDate.slice(0, 10)}T00:00:00Z`);
	return Math.round((expiry - today) / 86400000);
}

function formatIstDate(expiryDate) {
	return new Intl.DateTimeFormat("en-IN", {
		timeZone: TIMEZONE,
		day: "2-digit",
		month: "short",
		year: "numeric",
	}).format(new Date(`${expiryDate.slice(0, 10)}T00:00:00Z`));
}

function checkpointLabel(days) {
	return days === 0 ? "today" : `in ${days} day(s)`;
}

function buildReminderEmail(documents) {
	const sorted = [...documents].sort((a, b) => a.checkpoint - b.checkpoint || a.expiryDate.localeCompare(b.expiryDate));
	const subject = sorted.length === 1
		? `DocuTrack: ${sorted[0].name} ${sorted[0].checkpoint === 0 ? "expires today" : `expires in ${sorted[0].checkpoint} day(s)`}`
		: `DocuTrack: ${sorted.length} documents need attention`;

	const textLines = [
		"Your DocuTrack reminders are due:",
		"",
	];

	const htmlItems = sorted.map((doc) => {
		const status = doc.checkpoint === 0 ? "expires today" : `expires in ${doc.checkpoint} day(s)`;
		textLines.push(`- ${doc.name} (${doc.category}) — ${status} on ${formatIstDate(doc.expiryDate)}`);
		return `
			<li style="margin:0 0 12px;">
				<strong>${escapeHtml(doc.name)}</strong><br>
				<span style="color:#4a5568;">${escapeHtml(doc.category)} · Expires ${escapeHtml(formatIstDate(doc.expiryDate))}</span><br>
				<span style="color:#5b5ce2;">${escapeHtml(status)}</span>
			</li>`;
	}).join("");

	textLines.push("", "To turn off reminder emails, open DocuTrack and disable Email reminders or delete your saved email.");

	const text = textLines.join("\n");
	const html = `
		<div style="font-family:Arial,sans-serif;color:#172033;line-height:1.6">
			<h2 style="margin:0 0 12px;color:#202a55;">DocuTrack reminder</h2>
			<p style="margin:0 0 14px;">The following documents are due soon:</p>
			<ul style="padding-left:20px;margin:0 0 18px;">${htmlItems}</ul>
			<p style="margin:0;font-size:12px;color:#5f6b7a;">To turn off reminder emails, open DocuTrack and disable Email reminders or delete your saved email.</p>
		</div>`;

	return { subject, text, html };
}

function buildTestEmail(email) {
	return {
		subject: "DocuTrack: test email",
		text: `This is a test email for ${email}.\n\nIf you received this, DocuTrack email reminders are configured correctly.\n\nTo turn off reminder emails, open DocuTrack and disable Email reminders or delete your saved email.`,
		html: `
			<div style="font-family:Arial,sans-serif;color:#172033;line-height:1.6">
				<h2 style="margin:0 0 12px;color:#202a55;">DocuTrack test email</h2>
				<p style="margin:0 0 14px;">This is a test email for <strong>${escapeHtml(email)}</strong>.</p>
				<p style="margin:0 0 14px;">If you received this, DocuTrack email reminders are configured correctly.</p>
				<p style="margin:0;font-size:12px;color:#5f6b7a;">To turn off reminder emails, open DocuTrack and disable Email reminders or delete your saved email.</p>
			</div>`,
	};
}

async function sendEmailMessage(to, subject, text, html) {
	if (!transporter) {
		throw new Error("SMTP is not configured");
	}

	await transporter.sendMail({
		from: MAIL_FROM,
		to,
		subject,
		text,
		html,
	});
}

function parseSubscription(subscriptionJson, ownerId) {
	try {
		return JSON.parse(subscriptionJson);
	} catch {
		deleteSubscriptionStmt.run(ownerId);
		return null;
	}
}

function getDueDocuments() {
	const rows = dueDocsStmt.all();
	const due = [];

	for (const row of rows) {
		const checkpoint = daysLeftInIst(row.expiryDate);
		if (!CHECKPOINTS.includes(checkpoint)) {
			continue;
		}

		if (reminderExistsStmt.get(row.ownerId, row.docId, row.expiryDate, checkpoint)) {
			continue;
		}

		due.push({
			ownerId: row.ownerId,
			docId: row.docId,
			name: row.name,
			category: row.category,
			expiryDate: row.expiryDate,
			checkpoint,
			email: row.email,
			emailEnabled: Number(row.emailEnabled) === 1,
			subscription: row.subscriptionJson ? parseSubscription(row.subscriptionJson, row.ownerId) : null,
		});
	}

	return due;
}

function markReminderSent(doc) {
	insertReminderStmt.run(doc.ownerId, doc.docId, doc.expiryDate, doc.checkpoint, new Date().toISOString());
}

async function sendPushReminder(doc) {
	if (!doc.subscription) {
		return true;
	}

	const payload = {
		title: "DocuTrack expiry reminder",
		body: `${doc.name} ${doc.checkpoint === 0 ? "expires today" : `expires in ${doc.checkpoint} day(s)`}.`,
	};

	try {
		await webpush.sendNotification(doc.subscription, JSON.stringify(payload));
		return true;
	} catch (error) {
		if (error && [404, 410].includes(error.statusCode)) {
			deleteSubscriptionStmt.run(doc.ownerId);
		}

		console.error("DocuTrack push reminder failed");
		return false;
	}
}

async function sendDue() {
	const dueDocuments = getDueDocuments();
	if (!dueDocuments.length) {
		return;
	}

	const deliveryState = new Map();
	for (const doc of dueDocuments) {
		deliveryState.set(`${doc.ownerId}:${doc.docId}:${doc.expiryDate}:${doc.checkpoint}`, {
			doc,
			emailNeeded: Boolean(doc.emailEnabled && doc.email),
			emailDelivered: !(doc.emailEnabled && doc.email),
			pushNeeded: Boolean(doc.subscription),
			pushDelivered: !doc.subscription,
		});
	}

	const emailGroups = new Map();
	for (const state of deliveryState.values()) {
		if (!state.emailNeeded) {
			continue;
		}

		const bucket = emailGroups.get(state.doc.ownerId) || {
			email: state.doc.email,
			docs: [],
		};

		bucket.docs.push(state.doc);
		emailGroups.set(state.doc.ownerId, bucket);
	}

	for (const [ownerId, group] of emailGroups) {
		const { subject, text, html } = buildReminderEmail(group.docs);

		try {
			await sendEmailMessage(group.email, subject, text, html);
			for (const doc of group.docs) {
				const key = `${doc.ownerId}:${doc.docId}:${doc.expiryDate}:${doc.checkpoint}`;
				const state = deliveryState.get(key);
				if (state) {
					state.emailDelivered = true;
				}
			}
		} catch (error) {
			console.error(`DocuTrack email reminder failed for ${ownerId}`);
		}
	}

	for (const state of deliveryState.values()) {
		if (!state.pushNeeded) {
			continue;
		}

		state.pushDelivered = await sendPushReminder(state.doc);
	}

	const remindersToInsert = [];
	for (const state of deliveryState.values()) {
		if ((state.emailNeeded || state.pushNeeded) && state.emailDelivered && state.pushDelivered) {
			remindersToInsert.push(state.doc);
		}
	}

	if (!remindersToInsert.length) {
		return;
	}

	const insertMany = db.transaction((rows) => {
		for (const doc of rows) {
			markReminderSent(doc);
		}
	});
	insertMany(remindersToInsert);
}

function validateEmail(email) {
	return typeof email === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
}

app.get("/health", (_req, res) => {
	res.json({ ok: true });
});

app.post("/subscribe", (req, res) => {
	const { id, subscription } = req.body || {};
	if (!id || !subscription) {
		return res.status(400).json({ error: "Missing data" });
	}

	upsertSubscriptionStmt.run(String(id), JSON.stringify(subscription));
	return res.json({ ok: true });
});

app.post("/documents", (req, res) => {
	const { ownerId, documents } = req.body || {};

	if (!ownerId || !Array.isArray(documents)) {
		return res.status(400).json({ error: "Missing ownerId or documents" });
	}

	const normalizedDocs = documents
		.filter((doc) => doc && doc.id !== undefined && doc.id !== null)
		.map((doc) => ({
			ownerId: String(ownerId),
			docId: String(doc.id),
			name: String(doc.name || ""),
			category: String(doc.category || "Other"),
			expiryDate: String(doc.expiryDate || ""),
		}))
		.filter((doc) => doc.name && doc.category && doc.expiryDate);

	const replaceAll = db.transaction((rows) => {
		deleteOwnerDocsStmt.run(String(ownerId));
		for (const row of rows) {
			insertDocStmt.run(row);
		}
	});
	replaceAll(normalizedDocs);

	return res.json({ ok: true });
});

app.post("/email-settings", (req, res) => {
	const { ownerId, email, enabled } = req.body || {};
	const normalizedOwnerId = String(ownerId || "").trim();
	const normalizedEmail = String(email || "").trim();

	if (!normalizedOwnerId || !validateEmail(normalizedEmail)) {
		return res.status(400).json({ error: "Invalid ownerId or email" });
	}

	upsertUserStmt.run({
		ownerId: normalizedOwnerId,
		email: normalizedEmail,
		emailEnabled: enabled ? 1 : 0,
	});

	return res.json({ ok: true });
});

app.delete("/email-settings/:ownerId", (req, res) => {
	const ownerId = String(req.params.ownerId || "").trim();
	if (!ownerId) {
		return res.status(400).json({ error: "Missing ownerId" });
	}

	deleteUserStmt.run(ownerId);
	return res.json({ ok: true });
});

app.post("/test-email", async (req, res) => {
	const { ownerId } = req.body || {};
	const normalizedOwnerId = String(ownerId || "").trim();
	if (!normalizedOwnerId) {
		return res.status(400).json({ error: "Missing ownerId" });
	}

	const user = getUserStmt.get(normalizedOwnerId);
	if (!user) {
		return res.status(404).json({ error: "Email settings not found" });
	}

	const { subject, text, html } = buildTestEmail(user.email);
	try {
		await sendEmailMessage(user.email, subject, text, html);
		return res.json({ ok: true });
	} catch (error) {
		return res.status(500).json({ error: "Unable to send test email" });
	}
});

app.get("/email-settings/:ownerId", (req, res) => {
	const ownerId = String(req.params.ownerId || "").trim();
	if (!ownerId) {
		return res.status(400).json({ error: "Missing ownerId" });
	}

	const user = getUserStmt.get(ownerId);
	if (!user) {
		return res.status(404).json({ error: "Not found" });
	}

	return res.json({
		ownerId: user.owner_id,
		email: user.email,
		enabled: Number(user.email_enabled) === 1,
	});
});

app.post("/documents/sync", (_req, res) => res.status(404).json({ error: "Use POST /documents" }));

app.use((err, _req, res, _next) => {
	if (err) {
		if (err.message === "CORS blocked") {
			return res.status(403).json({ error: "CORS blocked" });
		}
		return res.status(500).json({ error: "Server error" });
	}

	return res.status(500).json({ error: "Server error" });
});

cron.schedule(
	"0 9 * * *",
	() => {
		void sendDue();
	},
	{ timezone: TIMEZONE }
);

void sendDue();

app.listen(PORT, () => {
	console.log(`DocuTrack server running on port ${PORT}`);
});
