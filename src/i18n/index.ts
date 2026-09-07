import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';

import en from './locales/en.json';
import de from './locales/de.json';
import fr from './locales/fr.json';
import es from './locales/es.json';
import it from './locales/it.json';
import nl from './locales/nl.json';
import pl from './locales/pl.json';
import pt from './locales/pt.json';
import ru from './locales/ru.json';
import ja from './locales/ja.json';
import zh from './locales/zh.json';
import ko from './locales/ko.json';
import hu from './locales/hu.json';
import tr from './locales/tr.json';

/**
 * Map BCP-47 locale codes (as stored in the flight store) to i18next language keys.
 * For example both 'en-GB' and 'en-US' resolve to the 'en' translation bundle.
 */
export const localeToLang: Record<string, string> = {
  'en-GB': 'en',
  'en-US': 'en',
  'de-DE': 'de',
  'fr-FR': 'fr',
  'es-ES': 'es',
  'it-IT': 'it',
  'nl-NL': 'nl',
  'pl-PL': 'pl',
  'pt-BR': 'pt',
  'ru-RU': 'ru',
  'ja-JP': 'ja',
  'zh-CN': 'zh',
  'ko-KR': 'ko',
  'hu-HU': 'hu',
  'tr-TR': 'tr',
};

const savedLang = localStorage.getItem('appLanguage') || 'en';
const initialLang = savedLang;

i18n.use(initReactI18next).init({
  resources: {
    en: { translation: en },
    de: { translation: de },
    fr: { translation: fr },
    es: { translation: es },
    it: { translation: it },
    nl: { translation: nl },
    pl: { translation: pl },
    pt: { translation: pt },
    ru: { translation: ru },
    ja: { translation: ja },
    zh: { translation: zh },
    ko: { translation: ko },
    hu: { translation: hu },
    tr: { translation: tr },
  },
  lng: initialLang,
  fallbackLng: 'en',
  interpolation: {
    escapeValue: false, // React already escapes
  },
});

export default i18n;
