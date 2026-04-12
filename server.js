// ══════════════════════════════════════════════════════════════════════════════
// WEEK BELOW — RAILWAY SERVER HANDLER ADDITIONS
// Add these cases to your existing ws.on('message') switch/if-else block
// Assumes you already have: const resend = new Resend(process.env.RESEND_API_KEY);
// and FROM_EMAIL = process.env.FROM_EMAIL || 'noreply@weekbelow.com'
// ══════════════════════════════════════════════════════════════════════════════

// ── feedback_reply ────────────────────────────────────────────────────────────
// Triggered when Taylor hits "Send Reply" on a bug/feature/feedback item
if (msg.type === 'feedback_reply') {
  const { feedbackId, userEmail, subject, replyText, senderName } = msg;

  if (!userEmail || !replyText) {
    console.warn('[feedback_reply] Missing userEmail or replyText');
    return;
  }

  try {
    await resend.emails.send({
      from:    FROM_EMAIL,
      to:      userEmail,
      subject: subject || 'Re: your feedback',
      html: `
        <div style="font-family:'DM Sans',sans-serif;max-width:560px;margin:0 auto;color:#111;font-size:14px;line-height:1.6;">
          <div style="background:#7c6fff;padding:16px 24px;border-radius:8px 8px 0 0;">
            <div style="color:#fff;font-size:16px;font-weight:600;">Week Below</div>
          </div>
          <div style="background:#fff;padding:24px;border:1px solid #e5e7eb;border-top:none;border-radius:0 0 8px 8px;">
            <p style="margin:0 0 16px;">Hi there,</p>
            <p style="margin:0 0 16px;">${escapeHtml(replyText)}</p>
            <hr style="border:none;border-top:1px solid #e5e7eb;margin:20px 0;"/>
            <p style="margin:0;font-size:12px;color:#6b7280;">
              Replied by ${escapeHtml(senderName || 'The Week Below team')}<br/>
              <a href="https://app.weekbelow.com" style="color:#7c6fff;">app.weekbelow.com</a>
            </p>
          </div>
        </div>
      `,
    });
    console.log(`[feedback_reply] Reply sent to ${userEmail} re: feedback ${feedbackId}`);
  } catch (e) {
    console.error('[feedback_reply] Email error:', e.message);
  }
}

// ── project_assigned ──────────────────────────────────────────────────────────
// Triggered when a team member is assigned to a project
if (msg.type === 'project_assigned') {
  const { to, userName, projectName, assignedBy } = msg;

  if (!to || !userName || !projectName) {
    console.warn('[project_assigned] Missing fields:', msg);
    return;
  }

  try {
    await resend.emails.send({
      from:    FROM_EMAIL,
      to:      to,
      subject: `You've been assigned to ${projectName}`,
      html: `
        <div style="font-family:'DM Sans',sans-serif;max-width:560px;margin:0 auto;color:#111;font-size:14px;line-height:1.6;">
          <div style="background:#7c6fff;padding:16px 24px;border-radius:8px 8px 0 0;">
            <div style="color:#fff;font-size:16px;font-weight:600;">Week Below</div>
          </div>
          <div style="background:#fff;padding:24px;border:1px solid #e5e7eb;border-top:none;border-radius:0 0 8px 8px;">
            <p style="margin:0 0 16px;">Hi ${escapeHtml(userName)},</p>
            <p style="margin:0 0 16px;">
              You've been added to <strong>${escapeHtml(projectName)}</strong>
              ${assignedBy ? ` by ${escapeHtml(assignedBy)}` : ''}.
            </p>
            <a href="https://app.weekbelow.com"
               style="display:inline-block;background:#7c6fff;color:#fff;padding:10px 20px;border-radius:6px;text-decoration:none;font-weight:600;font-size:13px;">
              Open Project →
            </a>
            <hr style="border:none;border-top:1px solid #e5e7eb;margin:20px 0;"/>
            <p style="margin:0;font-size:12px;color:#6b7280;">
              <a href="https://app.weekbelow.com" style="color:#7c6fff;">app.weekbelow.com</a>
            </p>
          </div>
        </div>
      `,
    });
    console.log(`[project_assigned] Notification sent to ${to} for project "${projectName}"`);
  } catch (e) {
    console.error('[project_assigned] Email error:', e.message);
  }
}

// ── feedback_submitted ────────────────────────────────────────────────────────
// Triggered when a user submits a bug/feature report — notifies Taylor
if (msg.type === 'feedback_submitted') {
  const { agencyId, userName, userEmail, feedbackType, subject, message: fbMessage } = msg;

  const TAYLOR_EMAIL = process.env.TAYLOR_EMAIL || 'taylor@below.co.nz';

  try {
    await resend.emails.send({
      from:    FROM_EMAIL,
      to:      TAYLOR_EMAIL,
      subject: `[${feedbackType || 'Feedback'}] ${subject || 'New submission'} — ${agencyId || 'unknown studio'}`,
      html: `
        <div style="font-family:'DM Sans',sans-serif;max-width:560px;margin:0 auto;color:#111;font-size:14px;line-height:1.6;">
          <div style="background:#1a1a2e;padding:16px 24px;border-radius:8px 8px 0 0;">
            <div style="color:#7c6fff;font-size:11px;font-weight:700;letter-spacing:1px;text-transform:uppercase;">Week Below Platform</div>
            <div style="color:#fff;font-size:16px;font-weight:600;margin-top:4px;">New ${escapeHtml(feedbackType || 'feedback')}</div>
          </div>
          <div style="background:#fff;padding:24px;border:1px solid #e5e7eb;border-top:none;border-radius:0 0 8px 8px;">
            <table style="width:100%;border-collapse:collapse;margin-bottom:16px;">
              <tr><td style="padding:6px 0;color:#6b7280;font-size:12px;width:90px;">Studio</td><td style="padding:6px 0;font-weight:500;">${escapeHtml(agencyId || '—')}</td></tr>
              <tr><td style="padding:6px 0;color:#6b7280;font-size:12px;">From</td><td style="padding:6px 0;font-weight:500;">${escapeHtml(userName || '—')} ${userEmail ? `&lt;${escapeHtml(userEmail)}&gt;` : ''}</td></tr>
              <tr><td style="padding:6px 0;color:#6b7280;font-size:12px;">Type</td><td style="padding:6px 0;font-weight:500;">${escapeHtml(feedbackType || '—')}</td></tr>
              <tr><td style="padding:6px 0;color:#6b7280;font-size:12px;">Subject</td><td style="padding:6px 0;font-weight:500;">${escapeHtml(subject || '—')}</td></tr>
            </table>
            <div style="background:#f9fafb;border-radius:6px;padding:14px;font-size:13px;line-height:1.6;white-space:pre-wrap;">${escapeHtml(fbMessage || '')}</div>
          </div>
        </div>
      `,
    });
    console.log(`[feedback_submitted] Notification sent to ${TAYLOR_EMAIL} from ${agencyId}`);
  } catch (e) {
    console.error('[feedback_submitted] Email error:', e.message);
  }
}

// ── feedback_status_update ────────────────────────────────────────────────────
// Just log it — no email needed, status is already saved in Supabase
if (msg.type === 'feedback_status_update') {
  console.log(`[feedback_status_update] feedback ${msg.feedbackId} → ${msg.status}`);
}

// ══════════════════════════════════════════════════════════════════════════════
// HELPER — add this near the top of your server file if not already present
// ══════════════════════════════════════════════════════════════════════════════
function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ══════════════════════════════════════════════════════════════════════════════
// ENV VARS TO ADD IN RAILWAY DASHBOARD
// ══════════════════════════════════════════════════════════════════════════════
// RESEND_API_KEY   — your Resend API key (probably already set)
// FROM_EMAIL       — e.g. "Week Below <noreply@weekbelow.com>"
// TAYLOR_EMAIL     — taylor@below.co.nz  (for feedback notifications)
