// Bedrock invitation email — the brand template, verbatim.
//
// Authored in Claude Design and exported as table-based email HTML, so it
// is NOT to be prettified, re-indented, or "modernised" into flexbox: every
// nested table and inline style in here is load-bearing in Outlook.
// Substitution is by __TOKEN__ rather than a template engine, so the file
// stays diffable against the design export.

export const INVITE_HTML = `<!-- ============================================================ -->
<!-- TEMPLATE 5 — YOU'RE INVITED                                   -->
<!-- ============================================================ -->
<span class="preheader">__INVITER__ invited you to __ORG__ on Bedrock.</span>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#e7e5e5;">
<tr><td align="center" style="padding:0 16px 40px 16px;">
<table role="presentation" class="container" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:600px;background:#f3f2f2;">
  <tr><td class="px" style="padding:36px 48px 0 48px;" bgcolor="#f3f2f2">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
      <td><table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
        <td style="padding-right:10px;"><table role="presentation" cellpadding="0" cellspacing="0" border="0" style="display:inline-table;vertical-align:middle;"><tr><td style="line-height:0;">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="22" style="width:22px;">
<tr><td height="3" bgcolor="#0088b0" style="font-size:1px;line-height:1px;">&nbsp;</td></tr>
<tr><td height="1" style="font-size:1px;line-height:1px;">&nbsp;</td></tr>
<tr><td height="3" bgcolor="#201e1d" style="font-size:1px;line-height:1px;">&nbsp;</td></tr>
<tr><td height="1" style="font-size:1px;line-height:1px;">&nbsp;</td></tr>
<tr><td height="3" bgcolor="#7d7979" style="font-size:1px;line-height:1px;">&nbsp;</td></tr>
<tr><td height="1" style="font-size:1px;line-height:1px;">&nbsp;</td></tr>
<tr><td height="3" bgcolor="#201e1d" style="font-size:1px;line-height:1px;">&nbsp;</td></tr>
</table></td></tr></table></td>
        <td style="font-family:Georgia,'Times New Roman',serif;font-size:20px;font-weight:bold;color:#201e1d;letter-spacing:-0.2px;">Bedrock</td>
      </tr></table></td>
      <td align="right" style="font-family:Arial,Helvetica,sans-serif;font-size:11px;letter-spacing:1px;color:#7d7979;text-transform:uppercase;">Subsurface Visualization Suite</td>
    </tr></table>
    <div style="height:1px;background:#d7d3d3;margin-top:20px;line-height:1px;font-size:1px;">&nbsp;</div>
  </td></tr>

  <tr><td class="px" style="padding:40px 48px 8px 48px;" bgcolor="#f3f2f2">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td
      style="font-family:Arial,Helvetica,sans-serif;font-size:11px;letter-spacing:1.5px;color:#0088b0;text-transform:uppercase;font-weight:bold;">
      YOU'RE INVITED</td></tr></table>
  </td></tr>
  <tr><td class="px" style="padding:6px 48px 0 48px;" bgcolor="#f3f2f2">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td
      style="font-family:Georgia,'Times New Roman',serif;font-size:28px;line-height:34px;color:#201e1d;">
      __INVITER__ invited you to __ORG__.</td></tr></table>
  </td></tr>
  <tr><td class="px" style="padding:14px 48px 0 48px;" bgcolor="#f3f2f2">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td
      style="font-family:Georgia,'Times New Roman',serif;font-size:16px;line-height:26px;color:#444141;">
      You've been invited to join <strong>__ORG__</strong> on Bedrock as __ROLE_ARTICLE__ <strong>__ROLE__</strong>. __ROLE_NOTE__</td></tr></table>
  </td></tr>

  <tr><td class="px" style="padding:24px 48px 0 48px;" bgcolor="#f3f2f2">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-top:1px solid #d7d3d3;border-bottom:1px solid #d7d3d3;">
      <tr>
        <td style="padding:16px 0;font-family:Arial,Helvetica,sans-serif;font-size:11px;letter-spacing:0.5px;color:#7d7979;text-transform:uppercase;width:34%;">Organization</td>
        <td style="padding:16px 0;font-family:Georgia,serif;font-size:15px;color:#201e1d;">__ORG__</td>
      </tr>
      <tr>
        <td style="padding:0 0 16px 0;font-family:Arial,Helvetica,sans-serif;font-size:11px;letter-spacing:0.5px;color:#7d7979;text-transform:uppercase;">Role</td>
        <td style="padding:0 0 16px 0;font-family:Georgia,serif;font-size:15px;color:#201e1d;">__ROLE__</td>
      </tr>
      <tr>
        <td style="padding:0 0 16px 0;font-family:Arial,Helvetica,sans-serif;font-size:11px;letter-spacing:0.5px;color:#7d7979;text-transform:uppercase;">Invited by</td>
        <td style="padding:0 0 16px 0;font-family:Georgia,serif;font-size:15px;color:#201e1d;">__INVITER__</td>
      </tr>
    </table>
  </td></tr>

  <tr><td class="px" style="padding:28px 48px 0 48px;" bgcolor="#f3f2f2">
    <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
      <td align="center" bgcolor="#0088b0" style="border-radius:3px;">
        <a href="__URL__" target="_blank"
          style="display:block;padding:14px 28px;font-family:Arial,Helvetica,sans-serif;font-size:14px;font-weight:bold;letter-spacing:0.5px;color:#ffffff;text-decoration:none;border-radius:3px;">
          ACCEPT INVITATION
        </a>
      </td>
    </tr></table>
  </td></tr>
  <tr><td class="px" style="padding:14px 48px 0 48px;" bgcolor="#f3f2f2">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td
      style="font-family:Arial,Helvetica,sans-serif;font-size:12px;line-height:20px;color:#7d7979;">
      This invitation expires on __EXPIRES__.</td></tr></table>
  </td></tr>

  <tr><td class="px" style="padding:32px 48px 40px 48px;" bgcolor="#f3f2f2">
    <div style="height:1px;background:#d7d3d3;line-height:1px;font-size:1px;margin-bottom:20px;">&nbsp;</div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td
      style="font-family:Arial,Helvetica,sans-serif;font-size:12px;line-height:20px;color:#7d7979;">
      If you weren't expecting this invitation, you can ignore this email.<br /><br />
      © 2026 Bedrock · getbedrock.ca
    </td></tr></table>
  </td></tr>
</table>
</td></tr>
</table>`;
