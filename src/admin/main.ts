// Entry point of the separate admin site (admin/index.html). Built with `npm run build:admin` into dist-admin/.
import './admin.css';
import { boot } from './app.js';
import { realApi } from './api.js';

void boot(document.getElementById('app') as HTMLElement, realApi);
