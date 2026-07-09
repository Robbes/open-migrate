import {getRequestConfig} from 'next-intl/server';
 
export default getRequestConfig(async ({requestLocale}) => {
  // This corresponds to the `[locale]` segment
  let locale = await requestLocale;

  // Validate that the incoming `locale` parameter is valid
  if (!locale || !['en', 'nl'].includes(locale)) {
    locale = 'en';
  }
 
  return {
    locale,
    messages: (await import(`./locales/${locale}.json`)).default
  };
});
