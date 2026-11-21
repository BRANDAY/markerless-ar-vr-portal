# Product concept

From a study prototype to something a customer could use. Written on 21 November 2026.
"Vrata" (Croatian for "door") is a working name used in these documents and in the mockups; it has not been
checked against trademarks. The choices marked **Proposal** are for the owner to confirm or change.
The main scenario (museums and heritage sites) was confirmed by the owner on 21 November 2026.

Related documents: [competitors.md](competitors.md), [ui-spec.md](ui-spec.md), [mockups/](mockups/index.html).

## 1. What exists today

Checked in the code and the server contract on 21 November 2026.

**Works**

- An AR scene with a door. Behind it is a virtual space (the atrium of the Sponza Palace). The user walks
  through the door into the space and back.
- The app finds the server on the local Wi-Fi by itself.
- The app records a room (video, camera poses, depth mesh) and uploads it. The server builds a map and a room
  plan with walls, corners and up to three door openings, picks the best opening, and returns the door's
  place for a camera frame.
- The app keeps the door in place through tracking loss and repeated position checks (implemented, not yet
  checked on a phone).

**Limits that shape the product**

| Limit | Consequence |
|---|---|
| The full loop has not run on a real phone recording yet. The only two phone recordings were under a second long and the build failed. | Everything below assumes the loop works in a real room. That has to be shown first. |
| Walking is 1:1. The user can go only as far as the real room allows. The atrium has about 4.4 m of free floor ahead of the door. | Large spaces need a way to move further in (section 5.5), and the user must be warned about real walls. |
| A server PC on the same Wi-Fi is required for a door that stays in place. No accounts, no encryption, local network only. | Fits a venue with its own network. Does not fit a casual home user. A hosted server needs new server work. |
| Scanning takes 1–2 minutes of walking. Building the map takes about 2.5–13 minutes depending on the PC. | The wait needs a designed screen. The scan should be done by someone motivated, once. |
| Android with ARCore only. One phone model tested (Xiaomi 14 Ultra). | iPhone owners are excluded unless the venue lends devices. |
| One room, one door, two built-in spaces, English only. All of the interface is debug controls. | Rooms, spaces, languages and the whole interface are new work. |
| The server cannot delete or rename a room, and keeps the uploaded video. | A promise "you can delete your room" needs a server change. |
| Finding the room takes about 3 seconds per try with the phone held still, at about 1 second of server time on a GPU. | The "finding your room" moment needs coaching, not a spinner. |

## 2. What the product is

A door that a place owns. Staff scan a room once and choose what is behind its doorway. From then on anyone
with the app, on that network, sees a door in that doorway and can walk into another place.

What is different from other products (details in [competitors.md](competitors.md)): the door finds its real
doorway by itself in every session, the room data stays on the customer's own machine, and there is no
charge per use.

## 3. Who would pay: four scenarios

| | A. Museums and heritage sites | B. Property developers and architects | C. Exhibitions, trade stands, shops | D. Schools and universities |
|---|---|---|---|---|
| Who pays | The venue, yearly. Often from project or tourism funding | The developer's sales office or the architecture firm, per project | The exhibitor or agency, per event | The institution, yearly; small budgets |
| What they get | A doorway in the building that opens onto a lost or distant interior. A reason to visit and to stay | A buyer walks from the sales office into the unbuilt flat at full size | A stand entrance that leads into a brand space. Something to queue for | A classroom door into a historic or scientific place |
| Who scans | Staff, once per room | Sales staff, once per office | Stand crew, on build-up day, under time pressure | A teacher |
| Devices | Loaned by the venue, or visitors' Android phones | Company tablets or phones | Stand devices | School tablets, often iPads |
| Fit with what exists | Strong. Rooms are fixed and large, a local server is acceptable, the first space is already a historic interior | Medium. Needs import of the customer's own 3D model at exact scale, on every project | Medium. Works technically, but a 15-minute setup on site with unknown Wi-Fi is risky | Weak today. iPads are common, and budgets are low |
| Must be built | Visitor mode, several rooms, a small library, languages, wall warning, staff setup that needs no developer | All of A, plus a model import pipeline and a scale check | All of A, plus a server on a laptop with its own hotspot, fast setup, branding | All of A, plus iOS |
| Competition | Venue guide platforms without 3D; one-off AR projects on platforms that are closing | Screen-based walk-throughs and headsets; none tied to a real door | Web AR portals placed by hand | Free content apps |
| Main risk | Slow buying cycles | Content effort on every sale | One failed event in front of a crowd | Price |

A fifth option, a consumer app for the home, is not proposed: free portal apps already exist, a home user
will not run a server, and nothing in the survey shows people paying for it.

### Decided: start with A, museums and heritage sites

Confirmed by the owner on 21 November 2026. Reasons:

1. **The strengths match.** A fixed room, a doorway that matters, a network the venue controls, and data that
   stays in the building.
2. **The first content already fits.** The Sponza atrium is a Croatian monument, and the survey found no
   maintained Croatian heritage AR product.
3. **The scan is done once by staff** and then serves every visitor. The slow part is paid once.
4. **Loaned devices remove the Android-only problem** and the need to install anything. Histovery works
   this way.
5. **There is a demonstrated willingness to pay for exactly this capability.** The Belvedere in Vienna paid
   for a pre-scanned hall with visual positioning, on a platform whose hosting ends in February 2027.
6. Scenario B reuses almost everything built for A. It becomes the second step once model import exists.

What this choice means for version 1: two roles (staff and visitor), venue-loaned Android devices as the
supported setup, visitors' own Android phones as a bonus, a server on a PC in the building.

### How it could be sold (assumptions to test, not findings)

- A yearly licence per venue for the app and server, with a one-time setup fee that covers installing the
  server and scanning the first rooms.
- Content sold separately: preparing a 3D space for a venue is project work.
- An optional hardware bundle: a small PC with a graphics card, delivered with the server installed.
- Published venue-software prices in the survey run from about EUR 1,000 to EUR 10,000 a year
  (Artivive, Smartify). A starting point inside that range is reasonable; the right number needs
  conversations with two or three venues.

## 4. Roles

| Role | Who | Sees |
|---|---|---|
| Visitor | A member of the public with a loaned or own phone | One welcome screen, the door, the space. No setup, no settings |
| Host | Venue staff who set the place up | Home, scanning, rooms, spaces, settings |
| Developer | Us | Everything the debug overlay shows today, behind developer options |

## 5. Features

Priority: **V1** = needed for a first sellable version in scenario A. **V1.x** = wanted soon after.
**Later** = only after customers ask.
Size: **S** = a few days, **M** = one to two weeks, **L** = several weeks. Sizes are rough and assume the
current code; "server" marks work outside the app.

### 5.1 First run and learning

| Feature | Priority | Size | Notes |
|---|---|---|---|
| Three welcome cards, shown once | V1 | S | New. No sign-up |
| Camera permission screen that says why and where the video goes | V1 | S | The permission gate exists; the explanation is new |
| "Try a door now" without a server: the door is placed in front of the user and is not remembered | V1 | S | The manual placement provider exists. Gives a first impression in under a minute, before any scan |
| Hints in context instead of a tutorial (scan, find the room, walk through) | V1 | S | Texts in [ui-spec.md](ui-spec.md) |

### 5.2 Scanning a room

| Feature | Priority | Size | Notes |
|---|---|---|---|
| One guided flow: prepare, scan, send, build, approve. Replaces the separate Scan, Record and Upload buttons | V1 | M | The pieces exist; the flow and screens are new |
| One instruction at a time while scanning, driven by tracking state: slow down, too dark, point at something with detail | V1 | S | ARCore reasons are already read |
| Minimum before "Finish": 60 seconds, floor found, a few metres walked. Hard stop at 3 minutes | V1 | S | Prevents the too-short recordings that fail on the server |
| Teal paint on captured walls and floor | V1 | S | Plane highlights exist; restyle. In the one device test no wall planes were found, so the depth mesh must carry the feedback if planes are missing |
| Build screen with one percentage, five named steps and time left | V1 | S | Server gives progress, stage and estimate |
| Room result: plan seen from above with the doorway marked; choose between doorways; reject and rescan | V1 | M | Server gives walls, corners, openings and a way to select one |
| "Room is ready" notification when the app is in the background | V1.x | S | Needs a notifications module |
| Keep the scan on the phone until the build succeeds; "send again" after a failure | V1 | S | Captures are stored; the pointer to the last one is lost on restart today |
| Refuse a too-short scan at upload | V1.x | S, server | Wanted in the server notes, not implemented |
| Add to an existing room instead of starting over | Later | L, server | |

### 5.3 Spaces behind the door

| Feature | Priority | Size | Notes |
|---|---|---|---|
| A library screen with the built-in spaces; choose one for a room; the choice is remembered | V1 | S | Two worlds exist behind a debug toggle |
| Credits and licence shown for every space | V1 | S | Required by the licences of most free models |
| The choice stored on the server with the room, so every phone shows the same space | V1 | S, server | Needed for a venue; today the choice lives in memory on one phone |
| A second and third real space | V1 | M each, content | Candidates were listed by the environment work; licences need checking for commercial use |
| Downloadable spaces from the server | V1.x | M, app and server | An endpoint was proposed by the environment work; not built |
| "About this place" sheet inside the space: name, date, a paragraph | V1 | S | |
| Audio narration; points of interest inside the space | V1.x | M | Expected by museums |
| Importing a customer's own 3D model | Later | L | Opens scenario B |

### 5.4 Several rooms

| Feature | Priority | Size | Notes |
|---|---|---|---|
| Rooms list with name and state (ready, building, scan again) | V1 | M | The server holds several maps; the app uses one fixed id |
| Naming a room when scanning | V1 | S | The server takes a label at upload |
| Recognising which room the phone is in | V1 | M, server | Today the room must be named in each request unless only one exists. First version: try the last room, then the others |
| Rename and delete a room, including its stored video | V1 | S, server | No such server call exists |
| Several doors in one room | Later | M | The server finds up to three openings but uses one |

### 5.5 A large space behind a small room

The user can walk only as far as the real floor allows. Four measures, in order of value:

| Feature | Priority | Size | Notes |
|---|---|---|---|
| Place each space so its best view is within two or three steps of the door | V1 | S, content | A rule for preparing spaces |
| Wall warning: a teal grid appears where a real wall is near, drawn from the room plan | V1 | M | Unique to this product: the server already knows the walls. Also a safety feature |
| "Door is behind you" pointer when the door is out of view | V1 | S | |
| Places to move to: tap a ring on the floor and the space shifts so that spot is under the user; the door stays in the real doorway | V1.x | M | Short fade to avoid discomfort. Not checked whether the portal library allows shifting the inner world while the user is inside |
| A way to turn the whole space | Later | M | |

### 5.6 Photo, video, sharing

| Feature | Priority | Size | Notes |
|---|---|---|---|
| Photo of the door or of the space, saved to the gallery, with a share button | V1 | S–M | The AR view can take a screenshot; saving and sharing need two small modules |
| Venue name or logo on the photo | V1.x | S | Free publicity for the venue |
| Video | Later | M | The same recorder is used for finding the room, so the two can collide |

### 5.7 Visitor and host modes

| Feature | Priority | Size | Notes |
|---|---|---|---|
| Visitor mode: one welcome screen and a Start button; setup hidden behind a staff PIN | V1 | M | |
| Venue name on the visitor screen, taken from the server's name | V1 | S | The server reports its name |
| Welcome text and languages set by the host | V1.x | S | |
| Phone locked to the app (Android screen pinning) | V1.x | S | A setup guide may be enough at first |
| Group mode: a guide starts the same content on all devices | Later | L | Seen in smart-glasses tours |

### 5.8 With a server, without one, or with a hosted one

| Mode | Priority | Size | Notes |
|---|---|---|---|
| Server on the venue's network (as today) | V1 | — | |
| Server installer for a non-developer, with a start icon and automatic firewall rule | V1 | M, server | Today: command line, six steps |
| No server: door placed by hand, not remembered. For trying the app and for demos | V1 | S | Exists |
| Hosted server run by us: encrypted connection, access keys, separate customers | Later | L, server | A rented GPU machine costs about USD 0.2–0.9 an hour (figures in the research notes). Removes the PC from the venue, gives up the "data stays in the building" promise |
| Hybrid: build the map on a rented machine, find the room on a small box in the venue | Later | L, server | The pattern larger vendors sell at a premium |
| Finding the room on the phone, no network | Later | L | Research task |

### 5.9 Problems the user can understand

| Feature | Priority | Size | Notes |
|---|---|---|---|
| Every state has plain words and one way forward: no server, wrong network, camera off, unsupported phone, scan failed, no doorway, room not recognised, tracking lost, door not confirmed | V1 | M | All of these states already exist in code with technical wording. Full table in [ui-spec.md](ui-spec.md) |
| No codes on screen; codes go to the log | V1 | S | |
| "Send a report" from settings | V1.x | S | The device log already goes to the server |

### 5.10 Permissions and privacy

| Feature | Priority | Size | Notes |
|---|---|---|---|
| Plain statement before the camera prompt and in settings: what is recorded, where it goes, how to delete it | V1 | S | |
| Deleting a room really deletes map, frames and video on the server | V1 | S, server | Without it the statement would be untrue |
| The server stops exposing its folder path and Windows user name | V1 | S, server | Noted in the server hand-over |
| A notice for the venue: scanning records the room; do it without visitors present | V1 | S | In the staff guide |
| A privacy policy and a data-processing text for venues | V1 | — | Legal text, outside the app |

### 5.11 Languages

| Feature | Priority | Size | Notes |
|---|---|---|---|
| All interface texts moved out of the code into one dictionary | V1 | S | Texts are hard-coded today |
| English and Croatian | V1 | S | |
| German, Italian and others; language chosen by the visitor on the welcome screen | V1.x | S each | Typical tourist languages on the Adriatic |
| Space descriptions in several languages | V1.x | S, content | |

### 5.12 Feel and polish

| Feature | Priority | Size | Notes |
|---|---|---|---|
| A sound and a short light change when crossing the threshold | V1.x | S | The library reports entering and leaving |
| Door opens as the user approaches | Later | M | A door leaf model exists, static |
| Only entering from the room side counts | V1.x | M | Today walking through from behind also enters |

## 6. What version 1 is

**Decided** (confirmed by the owner on 21 November 2026). The smallest set that a venue could run without
us in the room:

1. The redesigned interface with debug controls hidden.
2. The guided scan with doorway approval.
3. Home, rooms, a library of two or three spaces.
4. Visitor mode with a PIN.
5. Wall warning and "door is behind you".
6. Photo and share.
7. English and Croatian.
8. A server installer, and room delete on the server.

Before any of it: the core loop shown working in a real room on the test phone, and the project's own
accuracy and repeat-visit tests run, so there are real numbers to put next to the vendors' claims.

## 7. Risks and open points

- **The core loop in a real room is unproven.** Furniture, white walls, glass doors and mirrors are named as
  weak points in the server notes.
- **Phone range.** One phone model tested. The AR library has open issues on some Samsung models.
- **Content licences.** The Sponza model has two conflicting licence statements in its sources. Every space
  needs a licence that allows commercial use, written down.
- **Software licences.** The models the server uses for matching and for finding doors need a check for
  commercial use. Not checked in this document.
- **Setup by non-developers.** Until the installer exists, every sale includes a visit.
- **A ready-made service in the same library** (ReactVision, from USD 25 a month) can cover the "door stays
  in place" part for developers. Our answer is the doorway detection, the local data and the finished app.
- **iPhone.** The AR library supports iOS, but the scanning code depends on Android features. Size unknown.

## 8. Decisions for the owner

1. ~~The main scenario~~ — decided on 21 November 2026: A, museums and heritage sites.
2. The name and the visual identity. "Vrata" and the amber-and-teal look in the mockups are placeholders.
3. ~~Which features go into version 1~~ — decided on 21 November 2026: the set in section 6.
4. ~~Loaned devices or visitors' own phones~~ — decided on 21 November 2026: devices loaned by the venue
   are the main setup; visitors' own Android phones are an addition.
5. Whether a hosted server is wanted at all, given that local data is a selling point.
