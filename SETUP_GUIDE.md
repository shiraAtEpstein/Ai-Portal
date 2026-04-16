# AI Portal — Setup Guide

## What this is
A secure web portal that lets your staff access AI agents without needing a Claude account.
Workers log in with an invite code and chat with whichever agents their role permits.

---

## Step 1 — Get your Anthropic API key
1. Go to https://console.anthropic.com
2. Sign in (or create a free account)
3. Click **API Keys** → **Create Key**
4. Copy the key — you'll need it in Step 3

---

## Step 2 — Upload to GitHub
1. Create a free account at https://github.com if you don't have one
2. Create a **New Repository** (call it `ai-portal`, set it to **Private**)
3. Upload all the files in this folder to that repository
   - You can drag and drop them in the GitHub web interface
   - Make sure NOT to upload the `.env` file (it contains your secret key)

---

## Step 3 — Deploy on Render (free hosting)
1. Go to https://render.com and create a free account
2. Click **New** → **Web Service**
3. Connect your GitHub account and select the `ai-portal` repository
4. Fill in these settings:
   - **Name**: ai-portal (or whatever you like)
   - **Runtime**: Node
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
5. Click **Add Environment Variable** and add:
   - Key: `ANTHROPIC_API_KEY`  →  Value: your key from Step 1
6. Click **Create Web Service**
7. Wait ~2 minutes. Render gives you a URL like `https://ai-portal-xxxx.onrender.com`

That's your portal URL. Share it with your staff along with their invite codes.

---

## Managing Users

Open `config/users.json` to add, remove, or disable users.

**To add a user:**
```json
{
  "id": "6",
  "name": "New Employee",
  "role": "paralegal",
  "inviteCode": "PARA-XXXX",
  "disabled": false
}
```

**To revoke access:**
Change `"disabled": false` to `"disabled": true`

**Roles available:** admin, senior_lawyer, paralegal, marketing, receptionist

After editing, push the change to GitHub — Render will redeploy automatically.

---

## Managing Agents

Open `config/agents.json` to edit agents or roles.

Each agent has:
- `name` — display name shown in the portal
- `description` — short description shown to users
- `systemPrompt` — the secret instructions the agent follows (never visible to users)

Each role has:
- `agents` — list of agent IDs this role can access
- `topicRestrictions` — if set, the agent will only discuss these topics

---

## Invite Codes
Make them hard to guess. Use a format like `ROLE-XXXX` where XXXX is random letters/numbers.
Examples: `LAW-7X42`, `PARA-3B91`, `MKT-5R20`

Send each code privately to the relevant staff member. If a code is compromised, set `disabled: true` for that user and create a new one.

---

## Security Notes
- Your API key is stored only on the server — users never see it
- System prompts are never sent to users' browsers
- Sessions expire after 8 hours automatically
- All interactions are logged in the server console
- The portal runs over HTTPS (Render handles this automatically)
