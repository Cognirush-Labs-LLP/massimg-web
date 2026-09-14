import { createApp } from 'vue'
import { createPinia } from 'pinia'
import { scheduleImageMagickPreload } from '@/pipeline/codecs/loader'
import '@/styles/index.css'
import App from './App.vue'

createApp(App).use(createPinia()).mount('#app')

// Technical Design §12.1: ImageMagick's WASM fetched on idle after first paint (or on first
// interaction — `notifyImageAdded()` — whichever comes first, once T30+ wires Gallery to call it).
// Scheduled after mount, not before: nothing here may block first paint (§5.2).
scheduleImageMagickPreload()
