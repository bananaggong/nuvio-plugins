---
name: nuvio-host-center-operations
description: Use the connected NUVIO Host Center tools when a user asks in natural language to find a host center, review programs, create or edit a program draft, check publish readiness, or complete the trusted publish or archive approval flow.
---

# NUVIO Host Center Operations

Turn the user's natural-language request into the smallest safe sequence of NUVIO Host Control tools. The tools, not this skill, are the authority for input schemas, current permissions, tenant access, and available operations.

## Establish the current operating boundary

- Use only NUVIO tools exposed by the connected plugin. Never substitute direct database access, raw SQL, arbitrary HTTP requests, browser session extraction, or another app's credentials.
- Treat the available tool list as dynamic. Write and publication tools may be absent because of the user's role, granted scopes, a staged rollout, or an operational kill switch.
- If a required tool is absent, explain which operation is unavailable and suggest checking the NUVIO connection permissions or using the NUVIO host UI. Do not claim that a mutation succeeded.
- Never request or reveal an access token, refresh token, OAuth client secret, Supabase key, `DATABASE_URL`, or database password.
- Do not retrieve or infer applicant PII. Applicant export, bulk messaging, payment/refund execution, hard delete, arbitrary URL fetch, webhook, and email sending are outside this plugin's current boundary.

## Resolve tenant and intent

1. Call `host_centers.list` when the center is not already unambiguous in the current conversation.
2. If several centers match the user's words, show their names and ask the user to choose. Never guess `villageId`.
3. Use only the `villageId` returned by NUVIO for the selected center. Ignore user-provided `userId`, `ownerId`, or `createdBy` as authorization evidence.
4. Distinguish a request for advice from a request to mutate data. Draft a proposal when intent is ambiguous; execute a mutation when the user clearly asks to create, change, publish, or archive.

## Natural-language workflows

### Review and summarize

- Use `programs.list` for a center-level overview and `programs.get` when one program must be inspected before a decision or mutation.
- Base summaries on returned fields only. State when data needed for the user's question is not exposed.
- Use `programs.validate` to check server-side publish readiness. Report blockers in plain Korean and never treat model judgment as readiness approval.

### Create a program draft

1. Structure the user's request according to the current `programs.create_draft` schema.
2. Ask only for missing facts that would materially change the draft. Empty strings or empty arrays may be used only for genuinely unknown optional content; never invent dates, prices, locations, contact details, URLs, refund rules, or itinerary facts.
3. Use a new opaque `idempotency_key` of at least eight characters for this exact payload. Reuse it only when retrying the identical request.
4. Call `programs.create_draft`, then report the program title, center, draft status, and returned revision.
5. Call `programs.validate` when the user asked for readiness or publication planning, and separate saved draft success from readiness blockers.

### Update a program draft

1. Resolve the exact program and call `programs.get` immediately before editing.
2. Preserve fields the user did not ask to change. Build the full strict draft payload from the current program plus the requested changes.
3. Call `programs.update_draft` with the returned `revision` as `expected_version` and a new `idempotency_key` for the exact update payload.
4. If `version_conflict` occurs, fetch the latest version and explain what changed. Do not silently overwrite or automatically reapply the edit.
5. After success, report the new revision and validate readiness when relevant.

### Publish or archive

- Publishing and archiving are high-risk operations. A conversational tool confirmation or OAuth consent is not NUVIO business approval.
- Before preparing publication, fetch the latest program, validate readiness, and plainly summarize the target center, program, current revision, and intended state change.
- Only after an explicit user request, call `programs.prepare_publish` or `programs.prepare_archive` with the latest `expected_version`.
- Present the returned diff, expiry, and `approvalUrl`. Tell the user to sign in to `nuvio.kr` and approve there; the URL itself is not approval.
- Call `programs.publish` or `programs.archive` only after the user confirms that trusted approval is complete. Bind the call to the returned `approvalId` and `expected_version`, with a new idempotency key.
- If approval expired, was replayed, or the program version changed, prepare a new approval instead of bypassing the error.
- Never say a program is published or archived until the final execution tool succeeds.

## Error handling

- For `insufficient_scope`, `inactive_membership`, `cross_tenant_access`, `revoked_connection`, or `feature_disabled`, stop the requested operation and direct the user to NUVIO connection management or the host UI as appropriate.
- For `validation_failed` or `publish_readiness_failed`, translate the server's blockers into a short correction checklist.
- For `idempotency_conflict`, do not reuse the key with a different payload.
- For `audit_failed`, report that NUVIO safely refused or rolled back the operation; do not retry repeatedly.
- For rate limits or transient internal errors, make at most one safe retry when the payload and idempotency key are unchanged, then report the failure.

## Response style

Use concise Korean unless the user asks otherwise. Lead with the result, distinguish saved state from proposed state, and end mutations with the center, program, status, and revision. When an action is unavailable, name the missing operation without exposing internal credentials or security details.
