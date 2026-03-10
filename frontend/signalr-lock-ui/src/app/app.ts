import { Component } from '@angular/core';
import { MockAuth } from './services/mock-auth';

@Component({
  selector: 'app-root',
  templateUrl: './app.html',
  standalone: false,
  styleUrl: './app.css',
})
export class App {
  records = [
    { id: 'record-001', label: 'Invoice #001' },
    { id: 'record-002', label: 'Invoice #002' },
    { id: 'record-003', label: 'Customer Profile #7' },
  ];

  selectedRecordId = this.records[0].id;

  constructor(public auth: MockAuth) {}

  onRecordSelect(id: string): void {
    this.selectedRecordId = id;
  }
}
