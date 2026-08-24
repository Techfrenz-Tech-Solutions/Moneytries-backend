function resolveRecoveryIdentifier(identifierRaw) {
  const id = String(identifierRaw || '').trim();
  const isEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(id);
  const isPhone = /^\d{10}$/.test(id);
  if (!isEmail && !isPhone) return null;

  return {
    column: isEmail ? 'email' : 'phone',
    value: isEmail ? id.toLowerCase() : id,
    channel: isEmail ? 'EMAIL' : 'PHONE',
  };
}

// Gmail and Googlemail deliberately ignore dots in the local part. No other
// provider is canonicalized because dots can identify different mailboxes.
function gmailCanonicalLocal(email) {
  const [local, domain, ...rest] = String(email).toLowerCase().split('@');
  if (rest.length || !['gmail.com', 'googlemail.com'].includes(domain)) return null;
  return local.replaceAll('.', '');
}

module.exports = { resolveRecoveryIdentifier, gmailCanonicalLocal };
