import { NgModule } from '@angular/core';
import { BrowserModule } from '@angular/platform-browser';
import { CommonModule } from '@angular/common';
import { HttpClientModule } from '@angular/common/http';
import { ReactiveFormsModule } from '@angular/forms';
import { RouterModule } from '@angular/router';

import { App } from './app';
import { RecordEditor } from './components/record-editor/record-editor';
import { LockBanner } from './components/lock-banner/lock-banner';
import { RecordsListComponent } from './components/records-list/records-list.component';
import { RecordDialogComponent } from './components/record-dialog/record-dialog.component';

/**
 * Root NgModule.
 *
 * Declarations  – all components: App shell, RecordEditor, LockBanner, and list/dialog components.
 * Imports       – CommonModule enables structural directives (*ngIf, *ngFor, etc.)
 * RouterModule  – inlined with an empty route table (no separate routing file needed for this POC).
 */
@NgModule({
  declarations: [App, RecordEditor, LockBanner, RecordsListComponent, RecordDialogComponent],
  imports: [
    BrowserModule,
    CommonModule,
    RouterModule.forRoot([]),   // empty routes – extend here when adding pages
    HttpClientModule,
    ReactiveFormsModule,
  ],
  bootstrap: [App],
})
export class AppModule {}
