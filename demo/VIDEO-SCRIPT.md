# Night Desk: video script

The fallback video for the stage demo (#247), recorded from the live mode (`npm run demo -- --live`). About five minutes. Two screens: the laptop (the stage app, full screen) and a phone held to camera for the verify shots.

**Cast.** Elena Petrova, investigative reporter (a `self` account on pds.openfederation.net). Night Desk, her pen name. Marko, who wants to take credit (a custodial account).

**Before recording.** Pre-flight green. Elena's passes collected for the month. Phone on mobile data, with the camera app ready. Browser zoom so text reads on a small screen. Notifications off. Record the screen at 1080p; record the voice separately.

**Voice.** Plain words. No "keys", "DIDs" or "cryptography" in the narration; the screen carries the technical detail for anyone who wants it.

---

## 1. Start (0:00–0:25)

**Screen:** Start. Elena's name and newsroom.

**Voice:** "This is Elena. She investigates the people who run her city. Some stories she can't publish under her own name: not yet, maybe never. She needs a pen name that nobody can trace back to her. Not her editor, not her server, not anyone who breaks into it. And one day, if she chooses, she needs to prove it was her all along."

## 2. Passes (0:25–0:50)

**Screen:** Passes. Click "Collect this month's passes"; the counter shows 20.

**Voice:** "Every month, Elena's app collects twenty passes from her newsroom's server. Everyone gets the same twenty, whether they use them or not. A pass lets her create one pen name. The trick: the server signs the passes without ever seeing them, so later it can't tell which pass was hers."

## 3. Create (0:50–1:30)

**Screen:** Create. Type "Night Desk". Twelve words appear. Click through the check.

**Voice:** "She creates Night Desk. Twelve words appear. They are made here, on her laptop, and they never leave it. They *are* Night Desk: whoever holds them is Night Desk. There is no password reset and no recovery. If she loses them, Night Desk is gone. That's the price of nobody else being able to take it."

**Screen (hold 3 s):** the line "created with one pass, no sign-in".

**Voice:** "Notice what's missing. She didn't sign in. The server only saw a valid pass."

## 4. What the server knows (1:30–2:05)

**Screen:** Server, public view. Elena's history and Night Desk's history side by side. The verdict: nothing names the other.

**Voice:** "So what does the server know? Here is everything public about both accounts. Elena's history. Night Desk's history. Nothing in either points to the other. The server holds both, and still can't connect them."

## 5. Publish (2:05–2:35)

**Screen:** Publish. Sign in with the twelve words (or Touch ID if remembered). Publish the authorship claim for the article.

**Voice:** "Night Desk signs in with its twelve words and claims an article: a fingerprint of the text, published under the pen name. Anyone can check later that this exact text was claimed, and when."

## 6. Move (2:35–3:05)

**Screen:** Move. The six steps tick through; "On the new home: pds.grvty.app".

**Voice:** "Now Elena moves Night Desk to a different server, run by different people. The twelve words are all it takes. The new server gets a full copy, and the old server can't stop it or keep a hold on it. If a server is ever pressured, the pen name simply leaves."

## 7. Reveal (3:05–3:55)

**Screen:** Reveal. Click "Make the proof". VALID: "Night Desk belongs to Elena Petrova. Signed by Elena herself."

**Voice:** "A year later, the story has done its work, and Elena decides to step forward. She makes a proof that Night Desk is hers."

**Screen:** QR code. **Cut to the phone:** scan, the verify page opens, VALID.

**Voice:** "Anyone can check it on their own phone. Nothing goes through Elena's laptop: the phone checks it against a public record."

**Screen:** "Marko claims Night Desk". INVALID.

**Voice:** "Marko tries to claim Night Desk with the same proof. It fails: the proof was sealed to Elena from the moment Night Desk was created."

**Screen (if the contrast is on):** "Marko reveals his own pen name". VALID, "Signed by the server's key".

**Voice:** "And notice the difference. Marko lets his server hold his keys, so his proof is signed by the server. Elena's is signed by Elena. Only she could have made it."

## 8. In person (3:55–4:35)

**Screen:** In person. Someone off-camera calls out a word ("lighthouse"). Type it; Night Desk signs it. VALID.

**Voice:** "Sometimes Elena needs to prove it privately, face to face: to a lawyer, to a source. Someone picks a word on the spot. Night Desk's twelve words sign it, and the check passes. Nobody could have prepared that answer in advance."

**Screen:** "A stranger tries". INVALID. **Cut to the phone:** scan, VALID for Elena's signature.

## 9. Next (4:35–5:00)

**Screen:** Next.

**Voice:** "Pen names that nobody can trace, that move freely, and that only their owner can reveal. Open source, on servers newsrooms can run themselves. That's Open Newsrooms, built on OpenFederation."

---

## After recording

- Run `npm run demo -- --cleanup` so the rehearsal pen names don't stay in the public directory.
- Keep the raw footage; cut a 90-second version from scenes 1, 3, 7 and 8.
- Subtitles: the voice lines above are the subtitle text.
