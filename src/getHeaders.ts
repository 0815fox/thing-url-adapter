import { OutgoingHttpHeaders } from "http";

export function getHeaders(authentication: string, includeContentType: boolean = false) {
  const headers: OutgoingHttpHeaders = {
    Accept: 'application/json',
    Authorization: undefined
  };

  if (includeContentType) {
    headers['Content-Type'] = 'application/json';
  }

  switch (authentication.method) {
    case 'jwt':
      headers.Authorization = `Bearer ${authentication.token}`;
      break;
    case 'basic':
    case 'digest':
    default:
      // not implemented
      break;
  }

  return headers;
}
