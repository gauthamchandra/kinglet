package com.gauthamchandra.serviceusage.model;

import java.time.OffsetDateTime;
import java.util.Objects;

public record ProjectServiceState(
        String projectId, String serviceName, ServiceState state, OffsetDateTime lastUpdated) {
    public ProjectServiceState {
        Objects.requireNonNull(projectId, "Project ID cannot be null");
        Objects.requireNonNull(serviceName, "Service name cannot be null");
        Objects.requireNonNull(state, "Service state cannot be null");
        Objects.requireNonNull(lastUpdated, "Last updated timestamp cannot be null");
    }

    public static ProjectServiceState create(String projectId, String serviceName, ServiceState state) {
        return new ProjectServiceState(projectId, serviceName, state, OffsetDateTime.now());
    }

    public ProjectServiceState withState(ServiceState newState) {
        return new ProjectServiceState(projectId, serviceName, newState, OffsetDateTime.now());
    }

    public String getKey() {
        return projectId + ":" + serviceName;
    }

    public String getResourceName() {
        return "projects/" + projectId + "/services/" + serviceName;
    }
}
