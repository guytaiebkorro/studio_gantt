# Invite Delivery — Options & Recommendation

> **Status:** options document. Section 6 is the list of decisions that are the user's, not
> mine, and every server-side option below is still unapproved and unbuilt.
>
> **PARTLY SUPERSEDED — two thirds of phase 1 now ships.** Send invite copies the board link
> and opens a pre-composed draft (option A + option B), in `submitInvite()` in
> `src/ui/panel.js` and `buildInviteMailto()` / `copyText()` / `openMail()` in
> `src/share.js`. What phase 1 recommended and is still NOT built is **option C, the in-app
> welcome** — the person added six weeks ago who still doesn't know is not helped by any of
> this, because nothing greets them on first sign-in. `invitedBy` and `claimedAt == null` are
> already on the member document and are all it needs. Read section 3's option C and the
> phase 1 write-up as the remaining work, not as a proposal.

**The problem in one line:** inviting someone sends nothing. `inviteMember()` is a Firestore
write and that is all it is. The invited person finds out because the inviter tells them on
Slack, or they don't find out at all.

---

## 1. What actually happens today

### The mechanism

`inviteMember(wsId, email, role)` — **`src/memberships.js:138`** — is a single client-side
`setDoc` to `workspaces/{wsId}/members/{lowercased-email}`. Eight fields, nulls explicit,
`invitedBy`/`invitedAt` pinned by the rules to `me()` and `request.time` so they cannot be
forged (`firestore.rules`, the `allow create` branch under `match /members/{memberId}` at
**`firestore.rules:209`**).

There is no network call after that. No email, no queue, no outbox document, no function.
The UI path ends at **`src/ui/panel.js:416`** (`await handlers.onInvite(email, inviteRole)`),
which closes the dialog and re-renders the panel. `submitInvite()` at
**`src/ui/panel.js:406`** shows `"Inviting…"` and then nothing — and the word "Send" on
`#invite-send` (**`index.html:334`**) is, right now, a lie. That is the whole bug.

**The member document IS the invite.** There is deliberately no claim step —
**`src/memberships.js:9-14`** says so explicitly, and the rules are built around it. Access is
keyed by lowercased email rather than uid, so a person can be added months before they first
sign in and simply *has* access the first time they do. `bindMyIdentity()`
(**`src/memberships.js:95`**) later stamps `uid`/`displayName`/`claimedAt` on their own
document, and that write is purely diagnostic — `role` is excluded from the permitted key set,
so it grants nothing.

This is a genuinely good design and it is the reason this document is about *notification*
and nothing else.

### What the invited person actually experiences

Four cases, and three of them are bad:

1. **They are told out of band.** They open the app, click *Continue with Google*, and it
   works. This is the happy path and it depends entirely on a human remembering to send a
   Slack message.

2. **They are never told.** Nothing happens. Ever. They have full editor access to a board
   they don't know exists. There is no signal on their side — `listMyWorkspaces()`
   (**`src/memberships.js:43`**) would return the workspace the moment they signed in, but
   nothing prompts them to sign in. This is the *"they might already have access and not
   know"* case, and it is the most common failure in practice because it is silent on both
   ends: the inviter sees the address appear in the People list and reasonably assumes the
   job is done.

3. **The address was wrong.** The invite still succeeds. The rules only check that the
   document id is a well-formed lowercased email — not that anyone owns it. So a typo
   produces a member document for an address nobody will ever sign in as, sitting in the
   People list looking exactly like a pending invite. Nothing ever tells you it was wrong.

4. **The address was *nearly* right — the Gmail dot-alias problem.** `guy.taieb@gmail.com`
   and `guytaieb@gmail.com` are the same Gmail mailbox and both deliver, but they are
   **different strings**, and access here is granted per exact string. An admin who types the
   dotted form has created a member document the person's Google account will never match.
   They sign in, `listMyWorkspaces()` returns nothing, and they land on the `empty` gate view.
   This exact failure is why the *Copy my email* button exists at **`index.html:180`** /
   **`src/ui/gate.js:84-100`** — the comment there names Gmail dot-aliases specifically. The
   gate's fix is "copy the exact address and send it to an admin," which is a workaround for
   a wrong invite, not a delivery mechanism.

   Note also the `denied` gate view deliberately refuses to say whether the workspace exists
   (the rules deny reads identically for "not a member" and "doesn't exist"), so the invited
   person cannot debug this themselves at all.

### Where the app is, infrastructurally

- **Firebase project `korro-gantt`** (`.firebaserc`).
- **`firebase.json` configures Firestore rules + indexes and local emulators. Nothing else.**
  No `functions` block. No `hosting` block. There is no server-side code deployed for this
  app anywhere.
- **Hosting is GitHub Pages** (`README.md`, "Deploying": commit the static files, enable
  Pages, "any push updates the live app — there's no build step"). Repo is
  `github.com/guytaiebkorro/studio_gantt`.
  *(Caveat: the README is stale — it still describes the JSONBin/Master-Key era that
  `src/share.js` and `src/memberships.js` replaced. The hosting and no-build-step claims are
  still accurate; the collaboration-model section is not.)*
- **No dependencies, no build step.** Native ES modules; the Firebase SDK comes from the
  gstatic CDN through an importmap pinned to `12.18.0` (**`index.html:55-63`**, with a comment
  explaining why "latest" is forbidden). `npm install` is not part of shipping this app and
  nothing in `src/` has ever been transpiled.
- **`tools/admin/` is the one place server-side credentials already exist**, and they are
  *not* stored. It is a private Node CLI (`firebase-admin` ^13, `type: module`, node >= 20)
  that provisions workspaces and founding admins — the rules say `allow create: if false` for
  `/workspaces`, and this CLI is the only thing that can get around that because the Admin
  SDK authorizes through IAM and bypasses rules entirely. It authenticates via **Application
  Default Credentials** (`gcloud auth application-default login`), deliberately *not* a
  downloaded service-account key file — see the header of **`tools/admin/src/db.js`**, which
  is blunt about why: a key file is "a permanent, unexpirable, full-database credential
  sitting on disk in a git repo."

  **The consequence for this document:** there is no long-lived server credential anywhere in
  this project today. Any option that needs one (an SMTP password, a Resend API key) is
  introducing the first one, and the right home for it is Secret Manager attached to a
  function — never `tools/admin/`, and never the client.

---

## 2. The constraints any option has to respect

Four rules. An option that breaks any of them is out, however convenient.

**C1 — Notification only. Never a second access path.**
The member document is the grant. Anything we send is a *pointer* to something the recipient
either already has or doesn't. Concretely, the email must contain **no token, no signed link,
no "click here to accept," no `?invite=` parameter that any code path reads**. If the email is
forwarded to a stranger, the stranger gets nothing: they follow the link, sign in with Google,
and the rules deny them because there is no member document for their address. Every option
below gets an explicit verdict on this, because the tempting mistakes here are *exactly* the
industry-standard invite flows — and this app is deliberately not doing that.

**C2 — Don't break "no build step."**
`git push` deploys. No bundler, no `npm install` in the deploy path, no lockfile the browser
depends on. A Cloud Function is a *separate* deployable with its own `package.json` and its own
`firebase deploy` — that does not force a build step on the app, but it does end "the repo has
no node_modules the deploy cares about," and it makes `firebase deploy` a real step that
someone has to know about and get right. Options are marked accordingly.

**C3 — Don't regress the existing security properties.**
No client holds a sending credential. No email address becomes enumerable to someone who isn't
already a member (member lists are readable by members only — `firestore.rules:213`). No new
document with `allow create` from the client that a malicious member could use as a free spam
relay against arbitrary addresses. That last one is the sharp edge on the extension option.

**C4 — Failure must be visible.**
Today's silent failure is the actual complaint. An option that can silently not-send (SMTP
credential expired, function crashed, mail bounced) and leaves the inviter believing it worked
has fixed the wrong half of the problem. Whatever we build, the *inviter* has to be able to
see the state.

---

## 3. The options

### Option A — `mailto:` composed client-side

The dialog builds a `mailto:` URL with a prefilled subject and body naming the workspace, the
role, and the board link, and opens the user's own mail client. Ship a **"Copy invite text"**
button beside it for anyone whose browser doesn't have a mail handler wired up (very common on
desktop Chrome with webmail).

- **Cost:** £0, forever. No quota, no provider, no account.
- **Infrastructure added:** none. Zero. It is a string and a `location.href`.
- **Build step:** untouched. Pure client code in `src/ui/panel.js` + a button in the
  `#invite-dialog` block at **`index.html:316`**.
- **Deliverability:** *perfect*, and this is the underrated part. The mail is sent **from the
  inviter's real mailbox, by the inviter's real mail provider**. It has that person's sending
  reputation, it lands in the inbox, the recipient recognises the sender, and it threads into
  an existing conversation if they reply. No transactional email from a new domain will ever
  beat this on delivery.
- **C1 (second access path):** **No risk at all.** The client never had a credential to leak
  into the mail because there is no credential. The body is prose plus the existing
  `buildShareLink()` URL (`src/share.js`), which carries no secret by construction — its
  header comment spells that out: "Following it grants nothing."
- **C4 (visible failure):** partially. The inviter is *in* their mail client looking at the
  draft, so they know whether they sent it. But nothing records that they did, so the People
  list still can't distinguish "invited and told" from "invited and forgotten."
- **Honest downsides:** it needs a human to press Send. It doesn't work for bulk. On some
  managed desktops `mailto:` opens nothing at all and the user sees a no-op, which is why the
  copy-text fallback is mandatory rather than nice-to-have. And `mailto:` bodies are
  percent-encoded and plaintext — no formatting, and long bodies get truncated by some
  handlers (keep it under ~1500 characters to be safe).
- **Effort:** **1–2 hours.** Compose the string, two buttons, a toast, one test case.

### Option B — Copyable invite text / the board link

No email at all: after a successful invite, the dialog switches to a small "now tell them"
state with the ready-made message in a copy-to-clipboard box, and copies it automatically.

The link already exists and already carries nothing: `buildShareLink()` in **`src/share.js`**
produces `…/index.html#ws=<workspaceId>&b=<boardId>`, the panel already exposes *Copy a link
to this board* (**`index.html:304`**, wired at **`src/ui/panel.js:37`** →
**`src/boards.js:386`** → `copyLinkTo()`), and `copyLinkTo()`'s own toast already says the
right thing: *"Link copied — the recipient needs an invite to open it."* Note it also has a
`legacyCopy()` fallback for non-secure contexts, so the clipboard path is already hardened.

- **Cost:** £0. **Infrastructure:** none. **Build step:** untouched.
- **Deliverability:** N/A — the human chooses the channel, and in a Slack-first team Slack is
  genuinely the better channel than email.
- **C1:** **No risk.** This is the option the existing code was already designed for.
- **C4:** same partial answer as A.
- **Honest downsides:** it is not "sending an invite," it is admitting that a human sends the
  invite and making that ten seconds instead of two minutes. Some users will read it as the
  app shrugging. It is also nearly free to build, which is the point.
- **Effort:** **1 hour**, and most of it is copywriting. A and B are the same piece of work
  and should ship together.

### Option C — In-app notification for someone who arrives and finds themselves added

This one solves a *different* half of the problem and is the only option that fixes case 2
(never told) without depending on anyone remembering anything.

Today, someone who signs in and turns out to be a member is dropped straight into the board
with no acknowledgement. Two cheap additions:

1. **On sign-in, if this is the first time** — i.e. their own member document has
   `claimedAt == null` before `bindMyIdentity()` stamps it (**`src/memberships.js:95-109`**) —
   greet them: *"Amir added you to Game Dev as an editor."* `invitedBy` is already on the
   document, non-forgeable, and already read by `listMembers()`
   (**`src/memberships.js:127`**). The data needed is 100% already there.
2. **When a signed-in user is added to an additional workspace**, `listMyWorkspaces()` returns
   a workspace they've never opened; compare against the cached names in `localStorage`
   (`cachedName()`, **`src/memberships.js:185`**) and toast *"You've been added to X."* This
   costs nothing extra — the collection-group query already runs on every sign-in and on
   *Check again*.

- **Cost:** £0. Zero additional Firestore reads on path 1; path 2 reuses a query that already
  happens.
- **Infrastructure:** none. **Build step:** untouched.
- **C1:** **No risk** — it reads existing state and displays it. It cannot grant anything.
- **C4:** it doesn't help the inviter, but it does close the loop for the invitee, and it
  makes the `claimedAt` field earn its keep.
- **Honest downsides:** it only fires when they open the app. It is not a notification; it is
  a good welcome. Pair it with A/B; it does not replace them.
- **Effort:** **2–3 hours**, mostly deciding the copy and not double-toasting on every reload.
  Path 1 needs care: read `claimedAt` *before* `bindMyIdentity()` writes it, or you will never
  see the null.

### Option D — Firebase "Trigger Email from Firestore" extension

Install `firebase/firestore-send-email`, point it at a `mail` collection, and write a document
with `to` + `message.{subject,html}`. The extension's function picks it up and sends over SMTP.

**Verified today, and this is disqualifying: the Firebase Extensions service is deprecated and
shuts down 31 March 2027.** Already-installed extensions "will execute indefinitely," but
management features go away and no new installs or edits are permitted after that date;
migration guidance was slated for September 2026 — i.e. *now*, and I have not confirmed what
it says. ([Firebase
docs](https://firebase.google.com/docs/extensions/official/firestore-send-email),
[extensions.dev](https://extensions.dev/extensions/firebase/firestore-send-email))

Also verified: **the extension requires the Blaze plan**, runs on Cloud Functions, and
requires you to bring your own SMTP provider anyway — so it is not a way to avoid either the
billing upgrade or the email provider. It is only a way to avoid writing ~40 lines of function
code.

- **Cost:** Blaze required. Function usage sits inside the free allowance at this volume; the
  SMTP provider is a separate bill (see E).
- **Infrastructure:** an extension instance, a function, Secret Manager for the SMTP password,
  and a new Firestore collection. Plus a 2027 migration you have signed up for on day one.
- **Build step:** the app's is untouched, but `firebase.json` grows an `extensions` block and
  deploying becomes a real operation.
- **C1:** **No inherent risk** — the extension sends whatever you write; if the body has no
  token, there is no second path.
- **C3 — this is the sharp edge.** The trigger is *a Firestore document write*. If the client
  writes it directly, you must add rules for the `mail` collection, and anything the client
  can create it can create with an arbitrary `to` and an arbitrary `message.html`. That is an
  authenticated open mail relay wearing your sending domain. Mitigable (pin `to` to a
  `members/{id}` that exists, allow only a template id rather than a body, no update/delete),
  but the rules for it are fiddly and rules cannot count, so a member can still loop. The
  cleaner shape is to have a *function* write the mail document, at which point you have
  written Option E and the extension has bought you nothing.
- **Effort:** **3–5 hours** for the install and the rules, plus SMTP provider setup, plus a
  migration liability in ~7 months.
- **Verdict: no.** Adopting a service with a published shutdown date, to save writing 40 lines
  in the exact runtime it already uses, is a bad trade.

### Option E — Cloud Function + a transactional email provider

A single callable HTTPS function (`onCall`, so Firebase Auth verifies the ID token for you).
The client calls it after `inviteMember()` succeeds; the function re-checks with the Admin SDK
that the caller is an admin/editor of that workspace and that the member document exists, then
POSTs to a provider's API. Provider key in Secret Manager.

**This is the only option that actually "sends the invite" the way users expect.** It is also
the only one that adds real infrastructure.

**Verified pricing, September 2026:**

| Provider | Free tier | First paid tier | Notes |
|---|---|---|---|
| **Resend** | 3,000/mo, **but capped at 100/day** | Pro $20/mo, 50k | Pay-as-you-go overage since Dec 2025 |
| **Postmark** | 100/mo, permanent, no overage | from $15/mo | Best-regarded transactional deliverability |
| **SendGrid** | **none any more** — 60-day trial (100/day), then paid | Essentials ~$19.95/mo, 50k | Free plan discontinued 2025 |
| **Amazon SES** | $0.10 per 1,000; legacy 3,000/mo free tier only for accounts made before 15 Jul 2025 (newer accounts get $200 AWS credits instead) | pure usage | Cheapest at volume, most setup, no UI to speak of |

([Resend](https://www.stackscored.com/pricing/transactional-email/resend/),
[Postmark](https://costbench.com/software/email-api/postmark/),
[SendGrid alternatives / free-plan change](https://dreamlit.ai/blog/best-sendgrid-alternatives),
[SES](https://smtpedia.com/amazon-aws-ses-pricing/))

At this app's volume — a handful of invites a week — **every one of these is effectively free
and the price is not the deciding factor.** Postmark's 100/mo permanent free tier is plenty and
its deliverability reputation is the best of the four; Resend has the nicest API and the
100/day cap is irrelevant here.

**Firebase side, verified:** deploying Cloud Functions **requires the Blaze plan** — has done
since the Node 10 runtime in June 2020; `firebase deploy --only functions` on Spark returns
*"Your project must be on the Blaze (pay-as-you-go) plan to complete this command."*
Blaze includes a free allowance of 2M invocations, 400K GB-s, 200K CPU-s and 5 GB egress per
month, so **the function itself will cost nothing** — but Blaze means attaching a billing
account and accepting an unbounded bill in principle. Set a budget alert. Firestore's free
allowance (50K reads / 20K writes per day) is unaffected.
([Firebase pricing](https://firebase.google.com/pricing),
[Blaze-required-to-deploy](https://github.com/firebase/codelab-friendlychat-web/issues/603))

- **Cost:** ~£0/mo in practice. Blaze plan required. One provider account.
- **Infrastructure added:** a `functions/` directory with its own `package.json` and
  `node_modules`; a `functions` block in `firebase.json`; a Secret Manager secret; a verified
  sending domain with SPF and DKIM DNS records; and `firebase deploy --only functions` as a
  step that now exists and can be forgotten.
- **Build step:** **the app's is untouched** — this is server code, the browser never loads
  it. But it does mean the repo no longer has *zero* npm surface, and someone changing the
  invite flow now has to think about two deployables that ship on different cadences. **Say
  this out loud to the user before starting; it is the single biggest cultural change in this
  document.**
- **Deliverability — be pessimistic.** A first transactional email from a brand-new sending
  subdomain lands in spam or Promotions far more often than people expect, and this one is
  the worst possible shape for a filter: unsolicited, from an unknown domain, to someone who
  has never corresponded with you, containing a link, with the word "invite" in the subject.
  Verified requirements: Gmail expects **SPF or DKIM minimum plus TLS** from *all* senders,
  and both SPF and DKIM plus a `p=none` DMARC record from bulk senders; below the 5,000/day
  bulk threshold the hard enforcement doesn't apply, but "filtering algorithms favor
  authenticated mail for everyone" and unauthenticated mail is far likelier to be junked.
  Plan on SPF + DKIM + DMARC from day one, a real `korro.ai` subdomain rather than a provider
  sandbox address, and **the first few invites landing in spam anyway** while the subdomain
  has no history. ([Gmail sender
  guidelines](https://support.google.com/a/answer/81126?hl=en), [2026
  summary](https://wpmailsmtp.com/gmail-bulk-sender-requirements/))
- **C1:** **safe if disciplined, and this is where the discipline has to be written down.**
  The email must contain only the plain `buildShareLink()` URL. The temptations to refuse:
  no signed "accept" URL, no `?token=`, no one-time code, no Firebase Auth email-link
  sign-in (see the rejected list below). The function must also **not** create the member
  document — the client already did, via the rules, which is what keeps `invitedBy` honest.
  If the function ever writes the membership with the Admin SDK it bypasses the rules
  entirely and the non-forgeable audit trail at `firestore.rules` is dead. Its only job is
  "look up state, render prose, POST it."
- **C4:** this is the option that can actually satisfy it — the function knows the provider's
  response and can write `notifiedAt` / `notifyError` back onto the member document, letting
  the People list show *Emailed* vs *Not notified* honestly. That is real value beyond the
  email itself. (Note: that write needs an Admin-SDK path or a rules amendment, since the
  current key set is closed by `hasOnly` — adding a field is a rules change, not a free
  action. Worth costing.)
- **Effort:** **1–2 days** honestly. Half a day for the function and the client call; the rest
  is domain verification, DNS, Secret Manager, testing against the emulator, getting the
  template to not look like phishing, and the `notifiedAt` round-trip. Add a day if the DNS
  for `korro.ai` is not something the user controls directly.

### Option F — Send as the inviter, from the browser, via the Gmail API

A genuinely interesting middle path that almost nobody considers. Firebase Auth's Google
provider can request an extra OAuth scope (`gmail.send`); the credential from
`signInWithPopup` then carries an access token the browser can use to POST a message to the
Gmail API. The invite arrives **from the inviter's own Gmail**, with their reputation and
their signature, and no server exists anywhere.

- **Cost:** £0. No Blaze, no provider, no Functions.
- **Infrastructure:** none deployed — but an OAuth consent-screen configuration, which is a
  different kind of work.
- **Build step:** untouched.
- **Deliverability:** as good as Option A, because it *is* the inviter's mailbox — except it
  sends without the human, which is the whole appeal.
- **C1:** **no risk** to Firestore access. But note it introduces a *new* credential to the
  browser (a Gmail send token), which is a genuine widening of blast radius: an XSS in this
  app could send mail as the signed-in admin. Small, but real, and new.
- **The catch, verified:** `gmail.send` is classified a **sensitive** scope — it requires
  Google's OAuth app verification, though *not* the annual CASA third-party security
  assessment that restricted scopes (`gmail.readonly`, `gmail.modify`, `mail.google.com`)
  demand. So: verification paperwork, yes; security audit, no.
  ([scope tiers](https://bright-softwares.com/blog/en/google-workspace/gmail-oauth-scopes-decoded-the-3-tier-system-that-determines-your-launch-path),
  [sensitive-scope verification](https://developers.google.com/identity/protocols/oauth2/production-readiness/sensitive-scope-verification))
- **The second catch, and I think it kills it:** the escape hatch from verification is to set
  the OAuth consent screen to **Internal** (Workspace-org-only). But this project's consent
  screen is the same one Firebase Auth uses for *sign-in* — flipping it to Internal would
  restrict sign-in to `korro.ai` accounts and **break inviting anyone outside the
  organisation**, which is most of the point of an invite feature. *(Unverified: I have not
  checked the actual consent-screen configuration in the `korro-gantt` console. If it is
  already Internal, then external invites are already impossible and this whole document
  needs a different framing — worth checking.)* An access token also has ~1h lifetime and the
  extra scope makes the sign-in consent screen scarier for every user, including the ones who
  will never invite anybody.
- **Effort:** **half a day of code, plus an unbounded amount of Google verification calendar
  time.** The code is the easy part and the process is the risk.
- **Verdict:** clever, but it trades a small engineering problem for a Google review queue.
  Not phase 1. Reconsider only if the org decides invites are internal-only.

### Option G — A Google Apps Script mailer (the no-Blaze backend)

Deploy a tiny Apps Script web app under a `korro.ai` Workspace account. It receives a POST
from the client, **verifies the caller's Firebase ID token** (fetch Google's tokeninfo /
verify against the project's JWKS), then sends with `MailApp.sendEmail()` on the Workspace
account's own quota.

- **Cost:** £0, with the Workspace licence you already pay for. No Blaze. No provider account.
  Apps Script's send quota for Workspace accounts is in the low thousands per day —
  *unverified figure, check before relying on it* — which is orders of magnitude more than
  this app needs.
- **Deliverability:** **excellent**, and this is the reason to care. Mail leaves Google's
  infrastructure from an established `korro.ai` mailbox with existing SPF/DKIM and existing
  reputation. It sidesteps the entire new-sending-domain warmup problem in Option E.
- **Build step:** the app's is untouched. But the mailer lives in Apps Script, i.e. **outside
  this git repo**, in a Google account, deployed by clicking. For a codebase this deliberate
  about "the repo is the truth," that is a real smell and should be weighed as one.
- **C1:** no risk to access — same as E, it only sends prose.
- **C3 — this is the danger, and it is worse than it looks.** An Apps Script web app deployed
  "anyone, even anonymous" is a **public URL that sends email as your organisation**. If the
  ID-token verification is wrong or missing, you have handed the internet a free spam relay
  with `korro.ai` DKIM on it, and the reputational damage lands on the company's real mail
  domain, not on a throwaway subdomain. Verification must be done properly (validate
  signature, `aud == korro-gantt`, `iss`, expiry — not just "a token was present"), and the
  recipient must be constrained to an address that already exists as a member document.
  Doable, but this is security code written in an environment with no tests and no CI.
- **C4:** the script can return a result the client shows, but persisting it needs the same
  `notifiedAt` write as E.
- **Effort:** **half a day to a day**, and it is the half-day where a mistake is most
  expensive.
- **Verdict:** the strongest "no Blaze, real email" option, and worth keeping on the table
  precisely because of the deliverability advantage. But an off-repo, untested, public,
  mail-sending endpoint is a worse operational story than a Cloud Function, and the thing it
  saves — the Blaze upgrade — is cheap to just do.

### Explicitly rejected, and why (the tempting mistakes)

These will come up. They should be refused on sight, with a reason.

| Idea | Why not |
|---|---|
| **Firebase Auth email-link ("magic link") sign-in** | This is the C1 violation in its purest form: a bearer token in an email that authenticates whoever opens it. It would let a forwarded email sign someone in — and worse, it would make *email possession* the credential, when the whole design keys access to a verified Google identity (`googleVerified()` in the rules). Firebase Auth's own invite/action-link machinery is the wrong shape for this app. **Never.** |
| **An `invites` collection with a claim code** | Reintroduces the invite-claim step that `src/memberships.js:9-14` deliberately does not have, plus a second source of truth for access that can drift from `members/`. The rules comment at `firestore.rules:20` says there is deliberately no separate invites concept. |
| **Client writes directly to a `mail` collection** (whether the extension or a function drains it) | Authenticated open relay. See Option D, C3. If a mail document is written, a trusted server writes it. |
| **A Google Group as the ACL** | Would give free delivery via the group's welcome mail, but replaces a rules-enforced ACL with Workspace group membership that Firestore rules cannot read. Total redesign for a notification. |
| **Google Workspace SMTP relay (`smtp-relay.gmail.com`) from a function** | Not wrong, just not simpler: it still needs a function (Blaze), and the relay wants either IP allowlisting — impossible with dynamic Cloud Functions egress unless you add a VPC connector and a static NAT IP, which is real money and real complexity — or authenticated SMTP with an app password, which is a long-lived org credential in Secret Manager. If you want Google-reputation sending, Option G gets it more cheaply. |
| **Storing a provider API key in `tools/admin/`** | `tools/admin/src/db.js` documents, at length, why this project refuses on-disk long-lived credentials. Don't be the commit that reverses that. |

---

## 4. Comparison table

| | **A. `mailto:`** | **B. Copy text/link** | **C. In-app notice** | **D. Email extension** | **E. Function + provider** | **F. Gmail API (client)** | **G. Apps Script mailer** |
|---|---|---|---|---|---|---|---|
| Actually sends an email | yes, by hand | no | no | yes | yes | yes | yes |
| Needs no human to remember | no | no | **yes** | yes | yes | yes | yes |
| Monthly cost | £0 | £0 | £0 | £0 + provider | £0 in free tiers | £0 | £0 |
| Blaze plan required | no | no | no | **yes** | **yes** | no | no |
| New infrastructure | none | none | none | extension + fn + secret | fn + secret + DNS | OAuth scope | off-repo web app |
| Breaks app's "no build step" | no | no | no | no (adds deploy step) | no (adds 2nd deployable) | no | no (adds off-repo artifact) |
| Deliverability | **best** (human mailbox) | n/a | n/a | new-domain risk | **new-domain risk** | best | very good (Workspace) |
| C1 second-access-path risk | **none** | **none** | **none** | none if body is clean | none if disciplined | none (adds Gmail token) | none if body is clean |
| Open-relay / abuse risk | none | none | none | **high if client-written** | low (fn authorizes) | low | **high if auth is sloppy** |
| Inviter can see it worked | partly | partly | no | with extra work | **yes** | partly | with extra work |
| Effort | 1–2 h | ~1 h | 2–3 h | 3–5 h + migration debt | **1–2 days** | ½ day + Google review | ½–1 day |
| Verdict | **ship now** | **ship now** | **ship now** | **no** | **phase 2** | park | fallback if no Blaze |

---

## 5. Recommendation

### Phase 1 — this week: **A + B + C, together, no backend**

Ship the three zero-infrastructure options as one change. Together they close the loop from
both ends and cost about a day:

1. **On a successful invite, the dialog does not just close.** It becomes a short "now tell
   them" state: the composed message is already on the clipboard, with **Open in email** (the
   `mailto:`) and **Copy message** side by side, and the exact address echoed back so a typo
   is visible while the admin still remembers what they typed.
2. **The message text is fixed and boring on purpose** — who invited them, which workspace,
   which role, the plain `buildShareLink()` URL, and one line saying they sign in with Google
   using *this exact address*. No token. No accept button.
3. **First-sign-in welcome** (Option C, path 1) and **added-to-a-new-workspace toast** (path
   2), using `invitedBy` and `claimedAt`, which are already on the document.
4. **Rename the button.** `#invite-send` says *Send invite* and doesn't send. Either it sends
   or it says *Add to workspace*. The honest label is worth more than it sounds — it is the
   thing that stops an admin believing the job is done.

**Why this is the right phase 1 and not a cop-out:** the fastest path to an invited person
actually knowing is a human pressing Send in their own mail client, from an address the
recipient already trusts. It out-delivers anything we could build with a provider, it adds
nothing to operate, it cannot possibly become a second access path, and it does not touch the
billing plan. And step 3 fixes the failure mode that *no* email option fixes — the person who
was added six weeks ago and still doesn't know.

**One caveat to raise now:** phase 1 does not make the People list distinguish *invited* from
*invited and told*. If that distinction matters to the user, that is a `notifiedAt` field and
a rules change, and it belongs to phase 2 regardless of which sending mechanism wins.

### Phase 2 — if and only if phase 1 proves insufficient: **Option E**

The trigger to build it is a real one: "we invite people in batches," or "admins keep
forgetting," or "we need an audit trail of what was sent." Absent that, don't.

Shape it as: Blaze upgrade with a budget alert → **Postmark** (permanent free tier, best
transactional reputation, and at this volume price is irrelevant) → a verified `korro.ai`
sending subdomain with SPF, DKIM and DMARC before the first send → one `onCall` function that
re-authorizes the caller server-side, refuses to create the membership itself, sends prose with
no token, and writes `notifiedAt`/`notifyError` back so the People list can tell the truth.
Keep the phase-1 `mailto:` button *forever* as the manual override for when the mail lands in
spam — because for the first few weeks it will.

**Choose Option G instead of E only if the Blaze upgrade is refused.** It gets Workspace-grade
deliverability for free, at the price of a public mail endpoint living outside this repo, whose
security is entirely your own token-verification code. That is a worse trade than a billing
account, but it is a real one.

---

## 6. Open questions for the user

These are decisions I cannot make.

1. **Is upgrading `korro-gantt` to the Blaze plan acceptable?** It is required for *any*
   Cloud Function, gates options D and E entirely, and means attaching a billing account and
   accepting an in-principle unbounded bill (mitigable with a budget alert, not eliminable).
   Practical usage here would be £0. **If the answer is no, phase 2 is Option G or nothing.**
2. **Who owns DNS for `korro.ai`, and can we add SPF/DKIM/DMARC records for a sending
   subdomain?** If that is a ticket to someone else's team, Option E's timeline is theirs, not
   ours.
3. **Does the org already pay for an email provider** (SendGrid, Mailgun, Postmark, Mailchimp
   Transactional)? If so, use it — established reputation is worth more than a nicer API, and
   it removes both the account decision and most of the deliverability risk.
4. **Is `korro.ai` on Google Workspace, and would you rather invites came from a real
   `korro.ai` mailbox than from a no-reply subdomain?** That is the case for Option G over E,
   and it is a preference question as much as a technical one.
5. **Are invites ever to people outside the organisation?** If they are strictly internal, the
   OAuth consent screen could go Internal, which unlocks Option F without Google verification.
   If they are external — as I assume — F is off the table. **Related and worth checking in the
   console: what is the consent screen set to *today*?** If it is already Internal, external
   people cannot sign in at all and this document's premise shifts.
6. **Should the People list distinguish "invited" from "invited and notified"?** This is the
   only requirement that forces server-side work regardless of mechanism, because the member
   document's key set is closed by `hasOnly` in `firestore.rules` and adding `notifiedAt` is a
   rules change. If the answer is yes, that changes phase 1's scope.
7. **Do you want the invite email to come from the inviter or from the app?** From the inviter
   delivers better and feels personal; from the app is consistent and auditable. This is the
   fork between A/F/G and E, and it is a product call.
8. **Volume, honestly?** Every option is free at "a few a week." If the real answer is
   "hundreds when we onboard a studio," then A is inadequate on day one and E should be phase
   1 instead.

---

## Appendix — what I verified, and when

Checked **3 September 2026**. Pricing and product status date fast; re-check before acting.

- **Firebase Extensions is deprecated, shutting down 31 March 2027**; installed extensions
  keep running, no new installs/edits after that; migration guidance due September 2026 (not
  read). The Trigger Email extension **requires Blaze**, runs on Cloud Functions, and needs
  your own SMTP provider. —
  [firebase.google.com](https://firebase.google.com/docs/extensions/official/firestore-send-email),
  [extensions.dev](https://extensions.dev/extensions/firebase/firestore-send-email)
- **Cloud Functions cannot be deployed on the Spark plan** — Blaze required since the Node 10
  runtime, June 2020. Blaze free allowance: 2M invocations, 400K GB-s, 200K CPU-s, 5 GB
  egress per month. Firestore free: 50K reads / 20K writes per day. —
  [firebase.google.com/pricing](https://firebase.google.com/pricing),
  [firebase/extensions issue #603](https://github.com/firebase/codelab-friendlychat-web/issues/603)
  *(Note: the pricing page's table lists Cloud Functions allowances under Spark, which reads
  as though Spark can run functions. The CLI refuses. Trust the CLI.)*
- **Provider pricing:** Resend free 3,000/mo but 100/day; Pro $20/mo for 50k; PAYG overage
  since Dec 2025. Postmark free 100/mo permanent, paid from ~$15/mo. SendGrid's permanent free
  tier was **discontinued in 2025** — 60-day trial then ~$19.95/mo. SES $0.10/1,000; the
  3,000/mo free tier applies only to accounts created before 15 July 2025. —
  [Resend](https://www.stackscored.com/pricing/transactional-email/resend/),
  [Postmark](https://costbench.com/software/email-api/postmark/),
  [SendGrid](https://dreamlit.ai/blog/best-sendgrid-alternatives),
  [SES](https://smtpedia.com/amazon-aws-ses-pricing/)
- **Gmail sender requirements:** SPF *or* DKIM plus TLS for all senders; both plus DMARC
  `p=none` for bulk senders (5,000+/day to Gmail); one-click unsubscribe is marketing-only, so
  transactional invites are exempt from that specific rule. Unauthenticated mail is
  "far more likely to hit the spam folder regardless of volume." —
  [Gmail sender guidelines](https://support.google.com/a/answer/81126?hl=en),
  [2026 summary](https://wpmailsmtp.com/gmail-bulk-sender-requirements/)
- **`gmail.send` is a *sensitive* scope**, not restricted: needs Google OAuth app
  verification, does **not** need a CASA security assessment (that's `gmail.readonly`,
  `gmail.modify`, `mail.google.com`). —
  [scope tiers](https://bright-softwares.com/blog/en/google-workspace/gmail-oauth-scopes-decoded-the-3-tier-system-that-determines-your-launch-path),
  [Google sensitive-scope verification](https://developers.google.com/identity/protocols/oauth2/production-readiness/sensitive-scope-verification)

**Unverified, flagged in place:** Apps Script `MailApp` daily send quota for Workspace
accounts (Option G); the current OAuth consent-screen user type on `korro-gantt` (Option F,
question 5); what the September 2026 Extensions migration guidance actually says (Option D).
