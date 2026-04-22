# REST API Reference

Base URL: `/api`

## Authentication

No authentication is required in development mode. All endpoints are publicly accessible.

---

## Projects

### List Projects

```
GET /api/projects
```

**Response** `200 OK`

```json
{
  "data": [
    {
      "id": 1,
      "name": "My Project",
      "bpm": 120,
      "time_signature": "4/4",
      "count_in_note_value": "quarter",
      "inserted_at": "2026-04-22T10:00:00Z",
      "updated_at": "2026-04-22T10:00:00Z"
    }
  ]
}
```

### Create Project

```
POST /api/projects
Content-Type: application/json
```

**Request Body**

```json
{
  "project": {
    "name": "My Project",
    "bpm": 120
  }
}
```

**Response** `201 Created`

```json
{
  "data": {
    "id": 1,
    "name": "My Project",
    "bpm": 120,
    "time_signature": "4/4",
    "count_in_note_value": "quarter",
    "inserted_at": "2026-04-22T10:00:00Z",
    "updated_at": "2026-04-22T10:00:00Z"
  }
}
```

**Errors**
- `422 Unprocessable Entity` — validation failed (missing name, invalid BPM)

### Get Project

```
GET /api/projects/:id
```

**Response** `200 OK`

```json
{
  "data": { ... }
}
```

**Response Headers**
- `ETag: "a1b2c3d4..."` — MD5 hash of `"id:updated_at"`, used for optimistic locking

**Errors**
- `404 Not Found` — project does not exist

### Update Project (Optimistic Locking)

```
PUT /api/projects/:id
Content-Type: application/json
If-Match: "a1b2c3d4..."
```

**Request Body**

```json
{
  "project": {
    "name": "Renamed Project",
    "bpm": 140,
    "time_signature": "3/4",
    "count_in_note_value": "eighth"
  }
}
```

All fields are optional — only provided fields are updated.

**Response** `200 OK`

```json
{
  "data": { ... }
}
```

**Errors**
- `404 Not Found` — project does not exist
- `412 Precondition Failed` — `If-Match` value does not match current ETag (concurrent modification)
- `422 Unprocessable Entity` — validation failed
- `428 Precondition Required` — `If-Match` header was not provided

### Delete Project

```
DELETE /api/projects/:id
```

**Response** `204 No Content`

**Errors**
- `404 Not Found` — project does not exist

### Merge Tracks (Atomic Action)

```
POST /api/projects/:project_id/actions/merge-tracks
Content-Type: application/json
```

**Request Body**

```json
{
  "track_ids": [1, 2, 3],
  "new_name": "Merged Track"
}
```

This operation runs inside a single `Repo.transaction`:
1. Validates all track IDs belong to the project
2. Creates a new merged track
3. Deletes the original tracks

**Response** `201 Created`

```json
{
  "data": {
    "id": 10,
    "name": "Merged Track",
    "s3_key": "merged/...",
    "position_ms": 0,
    "project_id": 1
  }
}
```

**Errors**
- `400 Bad Request` — missing `track_ids` or `new_name`
- `404 Not Found` — project does not exist
- `422 Unprocessable Entity` — one or more track IDs do not belong to the project

---

## Samples

### List Samples (Paginated)

```
GET /api/samples?page=1&limit=50
```

**Query Parameters**
- `page` (integer, default: 1) — page number, minimum 1
- `limit` (integer, default: 50) — items per page, clamped to 1–100

**Response** `200 OK`

```json
{
  "data": [
    {
      "id": 1,
      "name": "Kick Drum",
      "genre": "electronic",
      "s3_key": "synth/1/kick_drum_1713790000",
      "duration_ms": 2000,
      "input_history": [ ... ],
      "bar_count": 1,
      "inserted_at": "2026-04-22T10:00:00Z"
    }
  ],
  "page": 1,
  "limit": 50,
  "total": 120
}
```

### Create Sample

```
POST /api/samples
Content-Type: application/json
```

**Request Body**

```json
{
  "sample": {
    "name": "Lead Synth",
    "genre": "electronic",
    "s3_key": "synth/1/lead_1713790000",
    "duration_ms": 4000,
    "bar_count": 2
  }
}
```

**Response** `201 Created`

**Errors**
- `422 Unprocessable Entity` — validation failed (missing name or s3_key, bar_count out of 1–16 range)

### Get Sample

```
GET /api/samples/:id
```

**Response** `200 OK`

### Delete Sample

```
DELETE /api/samples/:id
```

**Response** `204 No Content`

---

## Exports

### List Exports

```
GET /api/projects/:project_id/exports
```

**Response** `200 OK`

```json
{
  "data": [
    {
      "id": 1,
      "token": "550e8400-e29b-41d4-a716-446655440000",
      "status": "completed",
      "s3_key": "exports/1/550e8400.wav",
      "project_id": 1
    }
  ]
}
```

### Start Export (Idempotent)

```
POST /api/projects/:project_id/exports?token=UUID
```

The `token` query parameter makes this operation idempotent — replaying the same request with the same token is safe and will not create a duplicate export.

**Behavior by state:**

| Token State | Response |
|---|---|
| New (no existing export with this token) | `202 Accepted` — export job created |
| Existing, status = `"pending"` | `202 Accepted` — export already in progress |
| Existing, status = `"completed"` | `303 See Other` — `Location: /api/projects/:id/exports/:eid` |

**Errors**
- `400 Bad Request` — missing `token` query parameter
- `404 Not Found` — project does not exist

### Get Export

```
GET /api/projects/:project_id/exports/:id
```

**Response** `200 OK`

```json
{
  "data": {
    "id": 1,
    "token": "...",
    "status": "completed",
    "s3_key": "exports/...",
    "project_id": 1
  }
}
```

### Delete Export

```
DELETE /api/projects/:project_id/exports/:id
```

**Response** `204 No Content`

---

## Health Check

### Ping

```
GET /api/ping
```

Verifies that the Rust NIF is loaded and functional.

**Response** `200 OK`

```json
{
  "status": "ok",
  "nif": "loaded"
}
```

---

## HTTP Status Code Summary

| Code | Meaning | Used By |
|---|---|---|
| `200` | Success | GET, PUT |
| `201` | Created | POST (projects, samples, merge-tracks) |
| `202` | Accepted | POST exports (new or pending) |
| `204` | No Content | DELETE |
| `303` | See Other | POST exports (already completed) |
| `400` | Bad Request | Missing required parameters |
| `404` | Not Found | Resource does not exist |
| `412` | Precondition Failed | ETag mismatch on PUT |
| `422` | Unprocessable Entity | Validation errors |
| `428` | Precondition Required | Missing `If-Match` header on PUT |

## Error Response Format

All error responses follow this structure:

```json
{
  "errors": {
    "field_name": ["error message 1", "error message 2"]
  }
}
```

For non-field errors:

```json
{
  "errors": {
    "detail": "Not Found"
  }
}
```
