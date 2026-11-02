# Investigations (investigations)

## What it is for

Investigations where people decide: incident and log triage, forensics of the person's own systems, open-source
research on a subject the person is entitled to look into. Agents find, read, rank and cover; the person makes every
identification, attribution and remediation decision.

## How work runs

- **The mandate first**: the person writes `.harness/investigation-mandate.json` (purpose, the subjects that may be
  looked at, who authorized it, until when). Agents cannot write it.
- **investigation** (workflow): the investigator writes a coverage checklist, works through it, keeps each lead with
  its evidence in the harness's queue (`add_lead`), and writes `investigation/report.md`; the `coverage` gate checks
  every item is done or marked N/A with a reason.
- **decide_lead**: puts a lead to the person (confirmed, dismissed, needs more evidence); refused where nobody can be
  asked.
- **Recommended**: turn on the run recorder (`"record": true` in the settings) so the investigation's steps are kept
  in a hash-chained record that can be verified and exported.
- Never: face or voice recognition, profiling of people, untargeted collection of personal data (EU AI Act Art. 5;
  evaluating evidence in criminal investigations is high-risk under Annex III 6(c)).
