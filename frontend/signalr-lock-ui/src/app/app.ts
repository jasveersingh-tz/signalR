import { Component } from '@angular/core';
import { MockAuth } from './services/mock-auth';
import { MOCK_RECORDS, MockRecord } from './data/mock-records';

@Component({
  selector: 'app-root',
  templateUrl: './app.html',
  standalone: false,
  styleUrl: './app.css',
})
export class App {
  records: MockRecord[] = MOCK_RECORDS;
  selectedRecordId: string | null = null;

  constructor(public auth: MockAuth) {}

  onRecordSelected(recordId: string): void {
    this.selectedRecordId = recordId;
  }
}
