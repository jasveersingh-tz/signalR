import { NgModule, provideBrowserGlobalErrorListeners } from '@angular/core';
import { BrowserModule } from '@angular/platform-browser';
import { ReactiveFormsModule } from '@angular/forms';
import { RouterModule } from '@angular/router';
import { provideHttpClient } from '@angular/common/http';

import { App } from './app';
import { RecordEditor } from './components/record-editor/record-editor';
import { LockBanner } from './components/lock-banner/lock-banner';
import { RecordsListComponent } from './components/records-list/records-list.component';
import { RecordDialogComponent } from './components/record-dialog/record-dialog.component';

/**
 * Root NgModule.
 *
 * Declarations  – legacy (non-standalone) components: App shell, RecordEditor, LockBanner.
 * Imports       – RecordsListComponent and RecordDialogComponent are standalone and imported here
 *                 so the App shell template can use them without any extra wiring.
 * RouterModule  – inlined with an empty route table (no separate routing file needed for this POC).
 */
@NgModule({
  declarations: [App, RecordEditor, LockBanner],
  imports: [
    BrowserModule,
    RouterModule.forRoot([]),   // empty routes – extend here when adding pages
    ReactiveFormsModule,
    RecordsListComponent,
    RecordDialogComponent,
  ],
  providers: [provideBrowserGlobalErrorListeners(), provideHttpClient()],
  bootstrap: [App],
})
export class AppModule {}
