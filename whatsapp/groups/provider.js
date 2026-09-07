whatsapp/groups/provider.js — the one file I didn't rewrite whole (700+ lines,
I only read parts of it, and I'd rather hand you an exact patch than guess at
a file I can't see all of).

Inside the class's _ingest() method, find this exact block (it's the part that
runs right after a new WhatsApp message is written to processing_jobs):

    if (jobId) {
      enqueued++;
      if (dealId) {
        // Mark for the summary processor, and update the deterministic
        // "awaiting reply" signal (client in / firm out).
        try { await ingestDb.markDealNeedsUpdate(dealId); } catch (_) {}
        try { await ingestDb.noteDealActivity(dealId, info.direction, info.timestamp); } catch (_) {}
      }
    } else skipped++;

Replace it with:

    if (jobId) {
      enqueued++;
      if (dealId) {
        // Mark for the summary processor, and update the deterministic
        // "awaiting reply" signal (client in / firm out).
        try { await ingestDb.markDealNeedsUpdate(dealId); } catch (_) {}
        try { await ingestDb.noteDealActivity(dealId, info.direction, info.timestamp); } catch (_) {}
      }
      // Real-time responder trigger (7 Sept) — only for a genuine inbound
      // CLIENT message, never staff and never our own outbound. Debounced
      // per chat inside live-trigger.js, so this just schedules a run; it
      // never blocks message ingestion.
      if (info.direction === 'in' && !resolveSenderStaff(info, msg)) {
        try { require('../agent/live-trigger').scheduleDraft(info.chat_jid); } catch (_) {}
      }
    } else skipped++;

That's the whole change to this file. `resolveSenderStaff` is already imported
at the top of provider.js (it's used two lines above this block already), so
nothing else needs importing.

Paired with the new whatsapp/agent/live-trigger.js file (sent separately):
every real client message now schedules a draft ~45 seconds after the last
message in that chat, instead of waiting for someone to click "Generate
drafts". Set WA_RESPONDER_LIVE_TRIGGER=0 on Render to switch it off instantly
if anything looks wrong, with no code change — the admin button and the
twice-daily task-extraction batch keep working exactly as before either way.

One honest caveat, not a blocker: the task-extraction agent (the one that
fills deals.blocking_on / deal_items, which is where waiting_on and
last_firm_action come from for status-check replies) still only runs twice a
day (07:00 and 14:00, config/... WHATSAPP_PROCESS_TIMES). So a status-check
answered minutes after something changes may still reflect the last batch,
not the live conversation, until that's made event-driven too. Worth doing
next if the status-question drafts turn out stale in practice — happy to wire
it the same way (call processor.processDeal(dealId) from the same _ingest
hook) if you want it now instead of waiting to see.
