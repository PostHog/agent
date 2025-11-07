# @posthog/agent

## Unreleased

### Breaking Changes

- **TaskRun logs now stored in S3**: The `TaskRun.log` field has been replaced with `TaskRun.log_url` (a presigned S3 URL)
- Use the new `fetchTaskRunLogs(taskRun)` method to retrieve logs from S3
- Logs are stored as newline-delimited JSON for efficient streaming and appending
- The `TaskRunUpdate` interface no longer includes a `log` field

### Added

- New `fetchTaskRunLogs(taskRun)` helper method for reading logs from S3
- Standardized log fetching API that can be optimized in the future

## 1.4.0

### Minor Changes

- package now uses the LLM gateway instead of accepting an API key

## 1.3.1

### Patch Changes

- fix broken endpoint

## 1.3.0

### Minor Changes

- use new MCP by default and pass it through everywhere

## 1.2.0

### Minor Changes

- Add new funtion to write to posthog

## 1.1.0

### Minor Changes

- Moved build over to rollup

## 1.0.2

### Patch Changes

- update the rest of the inports to use .js

## 1.0.1

### Patch Changes

- change exports to .js
