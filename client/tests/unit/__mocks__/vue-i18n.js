// Mock pour vue-i18n
export const useI18n = () => ({
  t: (key) => key,
  locale: 'fr',
  t: (key, values) => {
    if (!values) return key;
    return Object.entries(values).reduce(
      (result, [k, v]) => result.replace(new RegExp(`{{${k}}}`, 'g'), v),
      key
    );
  },
  te: () => true,
  tm: () => ({}),
  d: (date) => String(date),
  n: (number) => String(number)
});

export const createI18n = (options) => ({
  global: {
    t: (key) => key,
    locale: options?.locale || 'fr',
    fallbackLocale: options?.fallbackLocale || 'fr',
    messages: options?.messages || {}
  },
  install: () => {}
});

export default {
  useI18n,
  createI18n,
  install: () => {}
};
