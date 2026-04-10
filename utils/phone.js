const normalizeKenyanPhone = (input) => {
  if (!input) return null;
  const digitsOnly = String(input).replace(/\D/g, '');
  if (digitsOnly.startsWith('254') && digitsOnly.length === 12) {
    return digitsOnly;
  }
  if (digitsOnly.startsWith('0') && digitsOnly.length === 10) {
    return `254${digitsOnly.slice(1)}`;
  }
  if (digitsOnly.length === 9) {
    return `254${digitsOnly}`;
  }
  return null;
};

const isValidKenyanPhone = (input) => {
  const normalized = normalizeKenyanPhone(input);
  return !!normalized && /^254\d{9}$/.test(normalized);
};

module.exports = {
  normalizeKenyanPhone,
  isValidKenyanPhone
};
