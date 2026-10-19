// Lets Node import the Worker runtime unchanged (it imports .wasm and .json the way workerd does).
import { register } from 'node:module';
register('./hooks.mjs', import.meta.url);
