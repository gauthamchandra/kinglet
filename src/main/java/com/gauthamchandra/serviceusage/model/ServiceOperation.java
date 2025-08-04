package com.gauthamchandra.serviceusage.model;

import java.time.OffsetDateTime;
import java.util.Objects;
import java.util.UUID;

public record ServiceOperation(
        String name,
        String projectId,
        OperationType type,
        OperationStatus status,
        OffsetDateTime startTime,
        OffsetDateTime endTime,
        String errorMessage) {
    public ServiceOperation {
        Objects.requireNonNull(name, "Operation name cannot be null");
        Objects.requireNonNull(projectId, "Project ID cannot be null");
        Objects.requireNonNull(type, "Operation type cannot be null");
        Objects.requireNonNull(status, "Operation status cannot be null");
        Objects.requireNonNull(startTime, "Start time cannot be null");
    }

    public enum OperationType {
        ENABLE_SERVICE,
        DISABLE_SERVICE,
        BATCH_ENABLE_SERVICES,
        BATCH_DISABLE_SERVICES
    }

    public enum OperationStatus {
        RUNNING,
        DONE,
        ERROR
    }

    public static ServiceOperation create(String projectId, OperationType type) {
        String operationName = "operations/" + UUID.randomUUID().toString();
        return new ServiceOperation(
                operationName, projectId, type, OperationStatus.RUNNING, OffsetDateTime.now(), null, null);
    }

    public ServiceOperation complete() {
        return new ServiceOperation(name, projectId, type, OperationStatus.DONE, startTime, OffsetDateTime.now(), null);
    }

    public ServiceOperation fail(String errorMessage) {
        return new ServiceOperation(
                name, projectId, type, OperationStatus.ERROR, startTime, OffsetDateTime.now(), errorMessage);
    }

    public boolean isDone() {
        return status == OperationStatus.DONE || status == OperationStatus.ERROR;
    }

    public boolean isError() {
        return status == OperationStatus.ERROR;
    }
}
