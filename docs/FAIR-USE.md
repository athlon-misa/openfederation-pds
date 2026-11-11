# Takedown and fair-use policy

This server hosts accounts and communities that follow its rules. When one
doesn't, the operator can take it down. A takedown follows AT Protocol's idea
of moderation: the content is removed from public view at once, but the
owner's data stays theirs. The owner can take it elsewhere, because their DID
(their identity) is not tied to this server.

This server is not a backup service. After a takedown, data is kept only for a
fixed time and then deleted.

The same rules apply to user accounts and to communities. For a community,
"the owner" means the account that owns it.

## The two kinds of takedown

| | Standard takedown | Hard takedown |
| --- | --- | --- |
| When | The server's rules were broken; nothing illegal | Illegal content is evident |
| Visible to the public | No, from the moment of the takedown | No, from the moment of the takedown |
| Owner can download their data | Yes, for **30 days** | No. Only the operator, for example to hand it to authorities |
| Writes, sign-in | None | None |
| What happens to the data | Deleted after 30 days | Kept unchanged for **90 days** (legal hold), then deleted |

The operator chooses the kind and must give a reason. The reason is shown to
the owner.

## Standard takedown, step by step

1. **Day 0.** The account or community is hidden. The owner gets an email with
   the reason, the deletion date, and a private download link.
2. **Any time before the deletion date**, the owner can use the link. It
   downloads the whole repository as a CAR file, the standard AT Protocol
   format that other servers import. The link also lists the owner's uploaded
   files (images and the like), each downloadable. The first download is
   confirmed by email, with the deletion date repeated. Downloading does not
   extend the deadline.
3. **7 days before deletion**, if nothing has been downloaded yet, the owner
   gets a reminder with a new link.
4. **On the deletion date**, the repository, its files and its keys are
   deleted from this server. The DID survives at the PLC directory, so the
   owner can still move the downloaded copy to another server.

Keep the link private: whoever has it can download the data. It stops working
on the deletion date, when the takedown is lifted, or when it becomes a hard
takedown.

## Hard takedown

For evident illegal content. The owner can't download anything, because
handing the material back can itself be unlawful and would defeat the point of
removing it. The data is kept unchanged for 90 days, so that authorities can
ask for it, and then deleted.

The owner is notified, with the reason and the date, unless an authority has
asked that they not be told.

## What the operator can do

- **Lift a takedown** before the deletion date, for example when an appeal is
  upheld. The account or community returns to its previous state, and the
  download links stop working.
- **Change the kind**: escalate a standard takedown to hard (the download link
  stops working at once), or the reverse.
- **Set another deletion date**, for example to extend a legal hold for a
  specific order.
- **Delete earlier**, through the normal delete functions.

Suspension is the softer step: a suspended account or community is hidden and
can't be written to, but nothing is scheduled for deletion and the owner can
still export.

## Appeals

Reply to the server operator before the deletion date. Each server lists its
contacts at `/.well-known/security.txt` and on its website.

## For operators

| Action | Endpoint |
| --- | --- |
| Take down (choose `standard` or `hard`), change the kind or the date | `net.openfederation.admin.takedown` (`did`, `tier`, `reason`, optional `deleteAfter`, optional `notify: false`) |
| Lift a takedown | `net.openfederation.admin.reverseTakedown` (`did`) |
| Standard takedown via the older endpoints | `net.openfederation.community.takedown`, `com.atproto.admin.updateSubjectStatus` |

A daily sweep sends the reminders and deletes what is due. It runs on one
server at a time, recorded in the database.
