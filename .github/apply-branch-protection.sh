#!/usr/bin/env bash
#
# Apply branch protection to `main`. Requires the repo to be PUBLIC, or the
# owning account to be on GitHub Pro/Team/Enterprise — GitHub blocks branch
# protection + rulesets on private repos for free accounts (HTTP 403
# "Upgrade to GitHub Pro or make this repository public").
#
# Run once after upgrading / going public:
#   ./.github/apply-branch-protection.sh
#
# Rules: CI (Node 18/20/22) must pass and be up to date, changes land via PR,
# linear history, no force-push, no branch deletion. enforce_admins is left
# off so the solo owner can hotfix without being locked out; raise the review
# count once there are other collaborators.
set -euo pipefail

REPO="${REPO:-rajanndube/jelly-local-sync}"

gh api -X PUT "/repos/${REPO}/branches/main/protection" --input - <<'JSON'
{
  "required_status_checks": {
    "strict": true,
    "contexts": ["test (18)", "test (20)", "test (22)"]
  },
  "enforce_admins": false,
  "required_pull_request_reviews": {
    "required_approving_review_count": 0,
    "dismiss_stale_reviews": true
  },
  "restrictions": null,
  "required_linear_history": true,
  "allow_force_pushes": false,
  "allow_deletions": false
}
JSON

echo "Branch protection applied to ${REPO}@main."
