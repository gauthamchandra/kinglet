package com.gauthamchandra.serviceusage.service;

import com.gauthamchandra.serviceusage.model.GcpService;
import com.gauthamchandra.serviceusage.model.ProjectServiceState;
import com.gauthamchandra.serviceusage.model.ServiceOperation;
import com.gauthamchandra.serviceusage.model.ServiceState;
import jakarta.enterprise.context.ApplicationScoped;
import jakarta.inject.Inject;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.stream.Collectors;

@ApplicationScoped
public class ServiceUsageService {

    @Inject
    ServiceRegistry serviceRegistry;

    private final Map<String, ServiceOperation> operations = new ConcurrentHashMap<>();

    public ServiceOperation enableService(String projectId, String serviceName) {
        try {
            ServiceOperation operation =
                    ServiceOperation.create(projectId, ServiceOperation.OperationType.ENABLE_SERVICE);
            operations.put(operation.name(), operation);

            serviceRegistry.enableService(projectId, serviceName);

            ServiceOperation completedOperation = operation.complete();
            operations.put(completedOperation.name(), completedOperation);
            return completedOperation;
        } catch (Exception e) {
            ServiceOperation operation =
                    ServiceOperation.create(projectId, ServiceOperation.OperationType.ENABLE_SERVICE);
            ServiceOperation failedOperation = operation.fail(e.getMessage());
            operations.put(failedOperation.name(), failedOperation);
            throw new IllegalArgumentException(e.getMessage());
        }
    }

    public ServiceOperation disableService(String projectId, String serviceName) {
        try {
            ServiceOperation operation =
                    ServiceOperation.create(projectId, ServiceOperation.OperationType.DISABLE_SERVICE);
            operations.put(operation.name(), operation);

            serviceRegistry.disableService(projectId, serviceName);

            ServiceOperation completedOperation = operation.complete();
            operations.put(completedOperation.name(), completedOperation);
            return completedOperation;
        } catch (Exception e) {
            ServiceOperation operation =
                    ServiceOperation.create(projectId, ServiceOperation.OperationType.DISABLE_SERVICE);
            ServiceOperation failedOperation = operation.fail(e.getMessage());
            operations.put(failedOperation.name(), failedOperation);
            throw new IllegalArgumentException(e.getMessage());
        }
    }

    public ServiceOperation batchEnableServices(String projectId, List<String> serviceNames) {
        try {
            ServiceOperation operation =
                    ServiceOperation.create(projectId, ServiceOperation.OperationType.BATCH_ENABLE_SERVICES);
            operations.put(operation.name(), operation);

            serviceRegistry.enableServices(projectId, serviceNames);

            ServiceOperation completedOperation = operation.complete();
            operations.put(completedOperation.name(), completedOperation);
            return completedOperation;
        } catch (Exception e) {
            ServiceOperation operation =
                    ServiceOperation.create(projectId, ServiceOperation.OperationType.BATCH_ENABLE_SERVICES);
            ServiceOperation failedOperation = operation.fail(e.getMessage());
            operations.put(failedOperation.name(), failedOperation);
            throw new IllegalArgumentException(e.getMessage());
        }
    }

    public ServiceOperation batchDisableServices(String projectId, List<String> serviceNames) {
        try {
            ServiceOperation operation =
                    ServiceOperation.create(projectId, ServiceOperation.OperationType.BATCH_DISABLE_SERVICES);
            operations.put(operation.name(), operation);

            serviceRegistry.disableServices(projectId, serviceNames);

            ServiceOperation completedOperation = operation.complete();
            operations.put(completedOperation.name(), completedOperation);
            return completedOperation;
        } catch (Exception e) {
            ServiceOperation operation =
                    ServiceOperation.create(projectId, ServiceOperation.OperationType.BATCH_DISABLE_SERVICES);
            ServiceOperation failedOperation = operation.fail(e.getMessage());
            operations.put(failedOperation.name(), failedOperation);
            throw new IllegalArgumentException(e.getMessage());
        }
    }

    public List<ProjectServiceState> listServices(String projectId, String filter) {
        if (filter != null && filter.contains("state:ENABLED")) {
            return serviceRegistry.listProjectServices(projectId, ServiceState.ENABLED);
        } else if (filter != null && filter.contains("state:DISABLED")) {
            List<GcpService> availableServices = serviceRegistry.listAvailableServices();
            List<ProjectServiceState> enabledServices =
                    serviceRegistry.listProjectServices(projectId, ServiceState.ENABLED);

            Map<String, ProjectServiceState> enabledServiceMap = enabledServices.stream()
                    .collect(Collectors.toMap(ProjectServiceState::serviceName, state -> state));

            return availableServices.stream()
                    .filter(service -> !enabledServiceMap.containsKey(service.name()))
                    .map(service -> ProjectServiceState.create(projectId, service.name(), ServiceState.DISABLED))
                    .collect(Collectors.toList());
        }

        List<GcpService> availableServices = serviceRegistry.listAvailableServices();
        List<ProjectServiceState> projectServices = serviceRegistry.listProjectServices(projectId);

        Map<String, ProjectServiceState> projectServiceMap =
                projectServices.stream().collect(Collectors.toMap(ProjectServiceState::serviceName, state -> state));

        return availableServices.stream()
                .map(service -> {
                    ProjectServiceState existingState = projectServiceMap.get(service.name());
                    if (existingState != null) {
                        return existingState;
                    }
                    return ProjectServiceState.create(projectId, service.name(), ServiceState.DISABLED);
                })
                .collect(Collectors.toList());
    }

    public ServiceOperation getOperation(String operationName) {
        ServiceOperation operation = operations.get(operationName);
        if (operation == null) {
            throw new IllegalArgumentException("Operation not found: " + operationName);
        }
        return operation;
    }

    public GcpService getServiceMetadata(String serviceName) {
        GcpService service = serviceRegistry.getService(serviceName);
        if (service == null) {
            throw new IllegalArgumentException("Service not found: " + serviceName);
        }
        return service;
    }

    public boolean isServiceEnabled(String projectId, String serviceName) {
        return serviceRegistry.isServiceEnabled(projectId, serviceName);
    }

    public void validateServiceAccess(String projectId, String serviceName) {
        serviceRegistry.validateServiceAccess(projectId, serviceName);
    }
}
