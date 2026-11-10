// Adaptador de persistencia para src/data/store.js sobre @capacitor/preferences.
// Para pasar a SQLite o IndexedDB basta escribir otro objeto con la misma forma { get, set }.
import { Preferences } from '@capacitor/preferences';

export const preferencesStorage = {
  async get(key) {
    const { value } = await Preferences.get({ key });
    return value;
  },
  async set(key, value) {
    await Preferences.set({ key, value });
  }
};
