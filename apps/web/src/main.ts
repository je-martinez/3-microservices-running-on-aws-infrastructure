import { bootstrapApplication } from '@angular/platform-browser';
import { appConfig } from './app/app.config';
import { App } from './app/app';
import { dismissBootLoader } from './app/core/boot/boot-loader';
import { initRum } from './app/core/observability/rum';

// CONTRACT: Before bootstrapApplication, at module scope. document-load reads
// the Navigation Timing API; starting the SDK inside an Angular provider
// leaves that span nothing to record. See [[2026-09-19-web-rum-integration-design]]
initRum();

bootstrapApplication(App, appConfig).catch((err) => {
  console.error(err);
  // CONTRACT: Dismiss on the failure path too. App's `afterNextRender` never
  // runs when bootstrap throws, and without this the user is left staring at
  // the navy loader forever with the error visible only in the console.
  dismissBootLoader();
});
