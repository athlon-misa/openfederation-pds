# Try it yourself: a pen name nobody can trace

A self-guided demo of OpenFederation for people on their own: about 15 minutes, a laptop and a phone. Unlike the stage demo, this uses the real dashboard with your own account.

## Before you publish this guide

It needs a server anyone can join without an invite. pds.openfederation.net is invite-only, so either:

- **a separate demo server (recommended):** install one with the setup wizard (#405) as a "newsroom or privacy-first server", then in Admin → Server settings turn **invite-only sign-up off** and keep **pen names on**. Wipe it on a schedule and say so at the top of this guide; or
- give each participant an invite code.

New accounts also wait for an admin's approval, and passes need an approved account. Until there is a setting to approve sign-ups automatically, someone has to approve participants in Admin → Users as they sign up (or the demo server needs that setting first).

Replace `DEMO_SERVER` below with that server's dashboard address.

---

## What you'll do

1. Create an account that only you control.
2. Look at what each choice means before you make it.
3. Create a pen name the server can't link to you.
4. Publish as the pen name.
5. Prove the pen name is yours, to someone standing next to you and to everyone.
6. Clean up.

You'll need: a laptop with a recent browser, and a phone with a camera. A pen and paper help.

## 1. Create your account (3 minutes)

1. Open `DEMO_SERVER/register`.
2. Choose a handle, an email address you can read, and a password.
3. Under **Who holds the key to your identity**, choose **Self**. Read the four answers on the screen: what it means, what you're responsible for, what can go wrong, how to undo it.
4. Tick the sentence you're asked to confirm, then continue.
5. Write down the **12 words** you're shown. They control your account. Three of them are asked back.

**What just happened:** your identity's master key was made in your browser and never sent to the server. The server can host your account, but it can't take it or move it.

## 2. Look around (2 minutes)

Open **Your account & identity** in the sidebar.

- **Identity & keys:** your mode (Self) and the other modes, each explained the same way.
- **Recovery:** the ways to recover if you lose your 12 words. Choose one to read what it means; you don't have to set it up today.
- **Glossary:** every term used in the dashboard, in plain words.

## 3. Your passes (1 minute)

Open **Pen names**.

- Your passes for this month have already been collected. Everyone gets the same number every month, whether they use them or not.
- Click **Save my passes to a file**. Keep the file on your laptop.

**Why a file:** creating a pen name needs a pass, not your sign-in. Taking the passes elsewhere means the pen name is never created anywhere near your account.

## 4. Create a pen name (3 minutes)

1. Open a **private window** (better still, Tor Browser), so it shares nothing with the window where you're signed in.
2. Go to `DEMO_SERVER/pen-names/new`. Don't sign in.
3. Load your passes file.
4. Choose a name for the pen name.
5. Read **What this protects, and what it doesn't**, and tick the confirmation that a pen name has no recovery.
6. Write down the pen name's **12 words**. They are different from your account's.

**What just happened:** the server received one valid pass and a new account. It can't tell which person's pass it was.

## 5. Publish as the pen name (2 minutes)

In the same private window:

1. Go to `DEMO_SERVER/pen-names` and sign in with the pen name's 12 words.
2. **Publish:** paste a paragraph of any text and claim it. Only a fingerprint of the text, its title and a link leave your laptop.
3. **Files & backup:** see what the pen name has published, as anyone could. Download a backup if you like.

## 6. Prove it's yours (3 minutes)

Still in the pen name's **Prove** tab:

**To someone next to you**

1. Ask them to say a word, any word.
2. Type it in **In-person proof**. The pen name signs it.
3. Scan the QR code with your phone (or theirs). The verify page opens and says **VALID**. Nobody could have prepared that answer before they heard the word.

**To everyone**

1. Open **I have decided to reveal that a pen name is mine**.
2. Your account is filled in. Type your **account's** 12 words, the ones from step 1, not the pen name's.
3. Scan the QR code. The verify page says **VALID**, names your account, and says **Signed by the person**: you signed it, not the server.

**Try to break it:** in step 2 type the pen name's words instead of your account's. It's refused before anything is signed.

## 7. Clean up (1 minute)

- In the pen name's window: **End** the pen name. You'll confirm with its 12 words and by typing its handle. It is removed from the server and closed for good in the public directory.
- Close the private window.
- Delete your account if you don't want to keep it.

## What you saw

- **An identity only you control:** the server hosts it but can't take it.
- **A pen name the server can't link to you:** created with an untraceable pass, never near your sign-in.
- **Proof on your terms:** private, face to face, or public; verified by anyone's phone against a public record, not by trusting the server.

## Honest limits

- The server can't connect your pen name to you through its data. What can connect them is *how* you use them: the same browser, the same network, the same moment. That's why step 4 uses a separate window, and why journalists use Tor Browser.
- Lose a pen name's 12 words and the pen name is gone. That's the price of nobody else being able to take it.
