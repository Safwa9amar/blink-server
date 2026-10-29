// Localized (en/fr/ar) transactional auth emails. Pure: no I/O.
import type { AuthLang } from "./auth-links";

export type AuthEmailType =
  | "signup"
  | "invite"
  | "magiclink"
  | "recovery"
  | "email_change"
  | "email"
  | "reauthentication"
  | "notification";

export interface AuthEmailInput {
  type: string; // unknown types fall back to "notification"
  lang: AuthLang;
  code?: string; // 6-digit OTP
  link?: string;
}

interface Copy {
  subject: string;
  heading: string;
  body: string;
  button: string;
  codeLabel: string;
  expiry: string;
}

type CopyTable = Record<AuthEmailType, Copy>;

const FOOTER: Record<AuthLang, string> = {
  en: "If you didn't ask for this, you can safely ignore this email.",
  fr: "Si vous n'êtes pas à l'origine de cette demande, ignorez simplement cet e-mail.",
  ar: "إذا لم تطلب ذلك، يمكنك تجاهل هذه الرسالة بأمان.",
};
const OR_CODE: Record<AuthLang, string> = { en: "Or use this code:", fr: "Ou utilisez ce code :", ar: "أو استخدم هذا الرمز:" };

const COPY: Record<AuthLang, CopyTable> = {
  en: {
    signup: { subject: "Confirm your Blink account", heading: "Confirm your email", body: "Welcome to Blink! Confirm your email address to finish creating your account.", button: "Confirm email", codeLabel: "Your confirmation code", expiry: "This code and link expire in 1 hour." },
    invite: { subject: "You're invited to Blink", heading: "You've been invited", body: "You've been invited to join Blink. Accept the invitation to set up your account.", button: "Accept invitation", codeLabel: "Your invitation code", expiry: "This code and link expire in 24 hours." },
    magiclink: { subject: "Your Blink sign-in code", heading: "Sign in to Blink", body: "Use the button or the code below to sign in.", button: "Sign in", codeLabel: "Your sign-in code", expiry: "This code and link expire in 1 hour." },
    recovery: { subject: "Reset your Blink password", heading: "Reset your password", body: "We received a request to reset your password. Use the button or the code below to choose a new one.", button: "Reset password", codeLabel: "Your recovery code", expiry: "This code and link expire in 1 hour." },
    email_change: { subject: "Confirm your new email address", heading: "Confirm your new email", body: "Confirm this change to update the email address on your Blink account.", button: "Confirm change", codeLabel: "Your confirmation code", expiry: "This code and link expire in 1 hour." },
    email: { subject: "Your Blink verification code", heading: "Your verification code", body: "Use the button or the code below to continue.", button: "Continue", codeLabel: "Your verification code", expiry: "This code and link expire in 1 hour." },
    reauthentication: { subject: "Confirm it's you", heading: "Confirm it's you", body: "Enter this code to confirm the sensitive action you requested.", button: "", codeLabel: "Your verification code", expiry: "This code expires in 10 minutes." },
    notification: { subject: "Security notice for your Blink account", heading: "Security notice", body: "A security-related change was made to your Blink account. If this was you, no action is needed. If not, reset your password right away.", button: "", codeLabel: "", expiry: "" },
  },
  fr: {
    signup: { subject: "Confirmez votre compte Blink", heading: "Confirmez votre e-mail", body: "Bienvenue sur Blink ! Confirmez votre adresse e-mail pour finaliser la création de votre compte.", button: "Confirmer l'e-mail", codeLabel: "Votre code de confirmation", expiry: "Ce code et ce lien expirent dans 1 heure." },
    invite: { subject: "Vous êtes invité(e) sur Blink", heading: "Vous avez été invité(e)", body: "Vous avez été invité(e) à rejoindre Blink. Acceptez l'invitation pour configurer votre compte.", button: "Accepter l'invitation", codeLabel: "Votre code d'invitation", expiry: "Ce code et ce lien expirent dans 24 heures." },
    magiclink: { subject: "Votre code de connexion Blink", heading: "Connexion à Blink", body: "Utilisez le bouton ou le code ci-dessous pour vous connecter.", button: "Se connecter", codeLabel: "Votre code de connexion", expiry: "Ce code et ce lien expirent dans 1 heure." },
    recovery: { subject: "Réinitialisez votre mot de passe Blink", heading: "Réinitialisez votre mot de passe", body: "Nous avons reçu une demande de réinitialisation de votre mot de passe. Utilisez le bouton ou le code ci-dessous pour en choisir un nouveau.", button: "Réinitialiser le mot de passe", codeLabel: "Votre code de récupération", expiry: "Ce code et ce lien expirent dans 1 heure." },
    email_change: { subject: "Confirmez votre nouvelle adresse e-mail", heading: "Confirmez votre nouvel e-mail", body: "Confirmez ce changement pour mettre à jour l'adresse e-mail de votre compte Blink.", button: "Confirmer le changement", codeLabel: "Votre code de confirmation", expiry: "Ce code et ce lien expirent dans 1 heure." },
    email: { subject: "Votre code de vérification Blink", heading: "Votre code de vérification", body: "Utilisez le bouton ou le code ci-dessous pour continuer.", button: "Continuer", codeLabel: "Votre code de vérification", expiry: "Ce code et ce lien expirent dans 1 heure." },
    reauthentication: { subject: "Confirmez votre identité", heading: "Confirmez votre identité", body: "Saisissez ce code pour confirmer l'action sensible que vous avez demandée.", button: "", codeLabel: "Votre code de vérification", expiry: "Ce code expire dans 10 minutes." },
    notification: { subject: "Alerte de sécurité sur votre compte Blink", heading: "Alerte de sécurité", body: "Une modification liée à la sécurité a été effectuée sur votre compte Blink. Si c'était vous, aucune action n'est requise. Sinon, réinitialisez immédiatement votre mot de passe.", button: "", codeLabel: "", expiry: "" },
  },
  ar: {
    signup: { subject: "أكّد حسابك في Blink", heading: "أكّد بريدك الإلكتروني", body: "مرحبًا بك في Blink! أكّد عنوان بريدك الإلكتروني لإكمال إنشاء حسابك.", button: "تأكيد البريد", codeLabel: "رمز التأكيد الخاص بك", expiry: "ينتهي هذا الرمز والرابط خلال ساعة واحدة." },
    invite: { subject: "تمت دعوتك إلى Blink", heading: "تمت دعوتك", body: "تمت دعوتك للانضمام إلى Blink. اقبل الدعوة لإعداد حسابك.", button: "قبول الدعوة", codeLabel: "رمز الدعوة الخاص بك", expiry: "ينتهي هذا الرمز والرابط خلال 24 ساعة." },
    magiclink: { subject: "رمز تسجيل الدخول إلى Blink", heading: "تسجيل الدخول إلى Blink", body: "استخدم الزر أو الرمز أدناه لتسجيل الدخول.", button: "تسجيل الدخول", codeLabel: "رمز تسجيل الدخول", expiry: "ينتهي هذا الرمز والرابط خلال ساعة واحدة." },
    recovery: { subject: "إعادة تعيين كلمة مرور Blink", heading: "إعادة تعيين كلمة المرور", body: "تلقينا طلبًا لإعادة تعيين كلمة مرورك. استخدم الزر أو الرمز أدناه لاختيار كلمة مرور جديدة.", button: "إعادة تعيين كلمة المرور", codeLabel: "رمز الاسترداد الخاص بك", expiry: "ينتهي هذا الرمز والرابط خلال ساعة واحدة." },
    email_change: { subject: "أكّد عنوان بريدك الإلكتروني الجديد", heading: "أكّد بريدك الجديد", body: "أكّد هذا التغيير لتحديث البريد الإلكتروني في حسابك على Blink.", button: "تأكيد التغيير", codeLabel: "رمز التأكيد الخاص بك", expiry: "ينتهي هذا الرمز والرابط خلال ساعة واحدة." },
    email: { subject: "رمز التحقق من Blink", heading: "رمز التحقق الخاص بك", body: "استخدم الزر أو الرمز أدناه للمتابعة.", button: "متابعة", codeLabel: "رمز التحقق الخاص بك", expiry: "ينتهي هذا الرمز والرابط خلال ساعة واحدة." },
    reauthentication: { subject: "أكّد هويتك", heading: "أكّد هويتك", body: "أدخل هذا الرمز لتأكيد الإجراء الحساس الذي طلبته.", button: "", codeLabel: "رمز التحقق الخاص بك", expiry: "ينتهي هذا الرمز خلال 10 دقائق." },
    notification: { subject: "تنبيه أمني بشأن حسابك في Blink", heading: "تنبيه أمني", body: "تم إجراء تغيير متعلق بالأمان على حسابك في Blink. إذا كنت أنت من قام بذلك فلا حاجة لأي إجراء، وإلا فأعد تعيين كلمة مرورك فورًا.", button: "", codeLabel: "", expiry: "" },
  },
};

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const KNOWN = new Set<string>(Object.keys(COPY.en));
const BRAND = "#EE335F";

export function renderAuthEmail(input: AuthEmailInput): { subject: string; html: string; text: string } {
  const type = (KNOWN.has(input.type) ? input.type : "notification") as AuthEmailType;
  const lang = input.lang;
  const c = COPY[lang][type];
  const rtl = lang === "ar";
  const dir = rtl ? "rtl" : "ltr";
  const align = rtl ? "right" : "left";
  const code = input.code && /^\d{4,8}$/.test(input.code) ? input.code : undefined;
  const link = type === "reauthentication" || type === "notification" ? undefined : input.link;
  const showCode = Boolean(code) && type !== "notification";

  const parts: string[] = [];
  parts.push(`<p style="margin:0 0 20px;font-size:15px;line-height:1.6;color:#374151;text-align:${align};">${escapeHtml(c.body)}</p>`);
  if (link && c.button) {
    parts.push(
      `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 24px;"><tr><td style="background:${BRAND};border-radius:10px;"><a href="${escapeHtml(link)}" style="display:inline-block;padding:14px 28px;font-size:15px;font-weight:bold;color:#ffffff;text-decoration:none;font-family:Arial,Helvetica,sans-serif;">${escapeHtml(c.button)}</a></td></tr></table>`
    );
  }
  if (showCode) {
    const label = link ? OR_CODE[lang] : c.codeLabel;
    parts.push(
      `<p style="margin:0 0 8px;font-size:13px;color:#6b7280;text-align:${align};">${escapeHtml(label)}</p>` +
        `<p dir="ltr" style="margin:0 0 20px;font-family:'Courier New',Courier,monospace;font-size:32px;font-weight:bold;letter-spacing:8px;color:#111827;text-align:${align};">${escapeHtml(code!)}</p>`
    );
  }
  if (c.expiry && (showCode || link)) {
    parts.push(`<p style="margin:0 0 20px;font-size:13px;color:#6b7280;text-align:${align};">${escapeHtml(c.expiry)}</p>`);
  }
  if (link) {
    parts.push(
      `<p style="margin:0 0 20px;font-size:12px;line-height:1.5;color:#9ca3af;word-break:break-all;text-align:${align};" dir="ltr">${escapeHtml(link)}</p>`
    );
  }

  const html = `<!doctype html>
<html lang="${lang}" dir="${dir}">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(c.subject)}</title></head>
<body style="margin:0;padding:0;background:#f3f4f6;font-family:Arial,Helvetica,sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f3f4f6;"><tr><td align="center" style="padding:24px 12px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:520px;background:#ffffff;border-radius:14px;">
<tr><td style="padding:28px 28px 0;text-align:${align};"><span style="font-size:26px;font-weight:bold;color:${BRAND};letter-spacing:0.5px;">Blink</span></td></tr>
<tr><td dir="${dir}" style="padding:20px 28px 8px;text-align:${align};">
<h1 style="margin:0 0 16px;font-size:20px;color:#111827;text-align:${align};">${escapeHtml(c.heading)}</h1>
${parts.join("\n")}
</td></tr>
<tr><td dir="${dir}" style="padding:0 28px 28px;"><hr style="border:none;border-top:1px solid #e5e7eb;margin:0 0 16px;"><p style="margin:0;font-size:12px;line-height:1.5;color:#9ca3af;text-align:${align};">${escapeHtml(FOOTER[lang])}</p></td></tr>
</table></td></tr></table>
</body></html>`;

  const text = [
    c.heading,
    "",
    c.body,
    link && c.button ? `\n${c.button}: ${link}` : "",
    showCode ? `\n${link ? OR_CODE[lang] : c.codeLabel} ${code}` : "",
    c.expiry && (showCode || link) ? `\n${c.expiry}` : "",
    "",
    FOOTER[lang],
    "",
    "Blink",
  ]
    .filter((l, i, a) => !(l === "" && a[i - 1] === ""))
    .join("\n");

  return { subject: c.subject, html, text };
}
