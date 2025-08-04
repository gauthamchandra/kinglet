package com.gauthamchandra.serviceusage.service;

import com.gauthamchandra.serviceusage.model.GcpService;
import com.gauthamchandra.serviceusage.model.ProjectServiceState;
import com.gauthamchandra.serviceusage.model.ServiceState;
import io.quarkus.runtime.StartupEvent;
import jakarta.enterprise.context.ApplicationScoped;
import jakarta.enterprise.event.Observes;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.stream.Collectors;

@ApplicationScoped
public class ServiceRegistry {

    private final Map<String, GcpService> availableServices = new ConcurrentHashMap<>();
    private final Map<String, ProjectServiceState> projectServiceStates = new ConcurrentHashMap<>();

    void onStart(@Observes StartupEvent ev) {
        initializeDefaultServices();
    }

    public boolean isServiceEnabled(String projectId, String serviceName) {
        String key = createKey(projectId, serviceName);
        ProjectServiceState state = projectServiceStates.get(key);
        return state != null && state.state() == ServiceState.ENABLED;
    }

    public void enableService(String projectId, String serviceName) {
        if (!isValidService(serviceName)) {
            throw new IllegalArgumentException("Unknown service: " + serviceName);
        }

        String key = createKey(projectId, serviceName);
        ProjectServiceState currentState = projectServiceStates.get(key);

        if (currentState != null && currentState.state() == ServiceState.ENABLED) {
            return;
        }

        ProjectServiceState newState = ProjectServiceState.create(projectId, serviceName, ServiceState.ENABLED);
        projectServiceStates.put(key, newState);
    }

    public void disableService(String projectId, String serviceName) {
        if (!isValidService(serviceName)) {
            throw new IllegalArgumentException("Unknown service: " + serviceName);
        }

        String key = createKey(projectId, serviceName);
        ProjectServiceState currentState = projectServiceStates.get(key);

        if (currentState != null && currentState.state() == ServiceState.DISABLED) {
            return;
        }

        ProjectServiceState newState = ProjectServiceState.create(projectId, serviceName, ServiceState.DISABLED);
        projectServiceStates.put(key, newState);
    }

    public void enableServices(String projectId, List<String> serviceNames) {
        for (String serviceName : serviceNames) {
            enableService(projectId, serviceName);
        }
    }

    public void disableServices(String projectId, List<String> serviceNames) {
        for (String serviceName : serviceNames) {
            disableService(projectId, serviceName);
        }
    }

    public List<ProjectServiceState> listProjectServices(String projectId) {
        String prefix = projectId + ":";
        return projectServiceStates.entrySet().stream()
                .filter(entry -> entry.getKey().startsWith(prefix))
                .map(Map.Entry::getValue)
                .collect(Collectors.toList());
    }

    public List<ProjectServiceState> listProjectServices(String projectId, ServiceState filterState) {
        String prefix = projectId + ":";
        return projectServiceStates.entrySet().stream()
                .filter(entry -> entry.getKey().startsWith(prefix))
                .map(Map.Entry::getValue)
                .filter(state -> state.state() == filterState)
                .collect(Collectors.toList());
    }

    public List<GcpService> listAvailableServices() {
        return List.copyOf(availableServices.values());
    }

    public GcpService getService(String serviceName) {
        return availableServices.get(serviceName);
    }

    public ProjectServiceState getProjectServiceState(String projectId, String serviceName) {
        String key = createKey(projectId, serviceName);
        return projectServiceStates.get(key);
    }

    public void validateServiceAccess(String projectId, String serviceName) {
        if (!isServiceEnabled(projectId, serviceName)) {
            throw new IllegalArgumentException("Service " + serviceName + " is not enabled for project " + projectId);
        }
    }

    private boolean isValidService(String serviceName) {
        return availableServices.containsKey(serviceName);
    }

    private String createKey(String projectId, String serviceName) {
        return projectId + ":" + serviceName;
    }

    private void initializeDefaultServices() {
        availableServices.put(
                "secretmanager.googleapis.com",
                GcpService.create(
                        "secretmanager.googleapis.com",
                        "Secret Manager API",
                        "Stores, manages, and secures access to application secrets.",
                        "https://cloud.google.com/secret-manager/docs"));

        availableServices.put(
                "serviceusage.googleapis.com",
                GcpService.create(
                        "serviceusage.googleapis.com",
                        "Service Usage API",
                        "Enables services that service consumers want to use on Google Cloud Platform.",
                        "https://cloud.google.com/service-usage/docs"));

        availableServices.put(
                "cloudtasks.googleapis.com",
                GcpService.create(
                        "cloudtasks.googleapis.com",
                        "Cloud Tasks API",
                        "Manages the execution of large numbers of distributed requests.",
                        "https://cloud.google.com/tasks/docs"));

        availableServices.put(
                "cloudscheduler.googleapis.com",
                GcpService.create(
                        "cloudscheduler.googleapis.com",
                        "Cloud Scheduler API",
                        "Creates and manages jobs run on a regular recurring schedule.",
                        "https://cloud.google.com/scheduler/docs"));
    }
}
