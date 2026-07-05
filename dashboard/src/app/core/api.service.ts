import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import type {
  JobDetail,
  JobFilters,
  JobsResponse,
  QueueStatPoint,
  QueuesResponse,
} from './models';

export const PAGE_SIZE = 25;

@Injectable({ providedIn: 'root' })
export class ApiService {
  private http = inject(HttpClient);

  queues(): Promise<QueuesResponse> {
    return firstValueFrom(this.http.get<QueuesResponse>('/api/queues'));
  }

  jobs(filters: JobFilters): Promise<JobsResponse> {
    let params = new HttpParams()
      .set('limit', PAGE_SIZE)
      .set('offset', filters.offset);
    if (filters.queue) params = params.set('queue', filters.queue);
    if (filters.state) params = params.set('state', filters.state);
    if (filters.id) params = params.set('id', filters.id);
    if (filters.from) params = params.set('from', new Date(filters.from).toISOString());
    if (filters.to) params = params.set('to', new Date(filters.to).toISOString());
    return firstValueFrom(this.http.get<JobsResponse>('/api/jobs', { params }));
  }

  job(queue: string, id: string): Promise<JobDetail> {
    return firstValueFrom(
      this.http.get<JobDetail>(`/api/queues/${encodeURIComponent(queue)}/jobs/${id}`),
    );
  }

  stats(queue: string, sinceMinutes = 180): Promise<{ points: QueueStatPoint[] }> {
    return firstValueFrom(
      this.http.get<{ points: QueueStatPoint[] }>(
        `/api/queues/${encodeURIComponent(queue)}/stats`,
        { params: new HttpParams().set('sinceMinutes', sinceMinutes) },
      ),
    );
  }

  retry(queue: string, id: string): Promise<{ ok: boolean }> {
    return firstValueFrom(
      this.http.post<{ ok: boolean }>(
        `/api/queues/${encodeURIComponent(queue)}/jobs/${id}/retry`,
        {},
      ),
    );
  }
}
