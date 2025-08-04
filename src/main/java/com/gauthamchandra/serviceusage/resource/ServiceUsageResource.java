package com.gauthamchandra.serviceusage.resource;

import com.gauthamchandra.serviceusage.api.DefaultApi;
import com.gauthamchandra.serviceusage.model.GcpService;
import com.gauthamchandra.serviceusage.model.ProjectServiceState;
import com.gauthamchandra.serviceusage.model.ServiceOperation;
import com.gauthamchandra.serviceusage.model.generated.BatchDisableServicesRequest;
import com.gauthamchandra.serviceusage.model.generated.BatchEnableServicesRequest;
import com.gauthamchandra.serviceusage.model.generated.Documentation;
import com.gauthamchandra.serviceusage.model.generated.ListServicesResponse;
import com.gauthamchandra.serviceusage.model.generated.Operation;
import com.gauthamchandra.serviceusage.model.generated.Service;
import com.gauthamchandra.serviceusage.model.generated.ServiceConfig;
import com.gauthamchandra.serviceusage.service.ServiceUsageService;
import jakarta.enterprise.context.RequestScoped;
import jakarta.inject.Inject;
import jakarta.ws.rs.Path;
import java.util.List;
import java.util.Map;

@RequestScoped
@Path("/v1")
public class ServiceUsageResource implements DefaultApi {

    @Inject
    ServiceUsageService serviceUsageService;

    @Override
    public Operation batchDisableServices(String project, BatchDisableServicesRequest batchDisableServicesRequest) {
        try {
            ServiceOperation operation =
                    serviceUsageService.batchDisableServices(project, batchDisableServicesRequest.getServiceIds());
            return createOperationResponse(operation);
        } catch (IllegalArgumentException e) {
            throw new jakarta.ws.rs.BadRequestException(e.getMessage());
        }
    }

    @Override
    public Operation batchEnableServices(String project, BatchEnableServicesRequest batchEnableServicesRequest) {
        try {
            ServiceOperation operation =
                    serviceUsageService.batchEnableServices(project, batchEnableServicesRequest.getServiceIds());
            return createOperationResponse(operation);
        } catch (IllegalArgumentException e) {
            throw new jakarta.ws.rs.BadRequestException(e.getMessage());
        }
    }

    @Override
    public Operation batchEnableServicesAction(String project, BatchEnableServicesRequest batchEnableServicesRequest) {
        return batchEnableServices(project, batchEnableServicesRequest);
    }

    @Override
    public Operation disableService(String project, String serviceName, Object body) {
        try {
            ServiceOperation operation = serviceUsageService.disableService(project, serviceName);
            return createOperationResponse(operation);
        } catch (IllegalArgumentException e) {
            throw new jakarta.ws.rs.BadRequestException(e.getMessage());
        }
    }

    @Override
    public Operation enableService(String project, String serviceName, Object body) {
        try {
            ServiceOperation operation = serviceUsageService.enableService(project, serviceName);
            return createOperationResponse(operation);
        } catch (IllegalArgumentException e) {
            throw new jakarta.ws.rs.BadRequestException(e.getMessage());
        }
    }

    @Override
    public Operation getOperation(String operationName) {
        try {
            ServiceOperation operation = serviceUsageService.getOperation(operationName);
            return createOperationResponse(operation);
        } catch (IllegalArgumentException e) {
            throw new jakarta.ws.rs.NotFoundException("Operation not found");
        }
    }

    @Override
    public ListServicesResponse listServices(String project, Integer pageSize, String pageToken, String filter) {
        List<ProjectServiceState> projectServices = serviceUsageService.listServices(project, filter);
        List<Service> serviceResponses =
                projectServices.stream().map(this::createServiceResponse).toList();

        return new ListServicesResponse().services(serviceResponses).nextPageToken(null);
    }

    private Operation createOperationResponse(ServiceOperation operation) {
        Operation response = new Operation()
                .name(operation.name())
                .done(operation.isDone())
                .metadata(Map.of(
                        "type", operation.type().toString(),
                        "projectId", operation.projectId()));

        if (operation.isError()) {
            response.error(new com.gauthamchandra.serviceusage.model.generated.Status()
                    .code(400)
                    .message(operation.errorMessage()));
        } else if (operation.isDone()) {
            response.response(Map.of("operationType", operation.type().toString()));
        }

        return response;
    }

    private Service createServiceResponse(ProjectServiceState projectServiceState) {
        String resourceName = projectServiceState.getResourceName();

        GcpService serviceMetadata = serviceUsageService.getServiceMetadata(projectServiceState.serviceName());

        ServiceConfig config = new ServiceConfig().name(serviceMetadata.name()).title(serviceMetadata.title());

        if (serviceMetadata.summary() != null || serviceMetadata.documentationUrl() != null) {
            Documentation docs = new Documentation();
            if (serviceMetadata.summary() != null) {
                docs.summary(serviceMetadata.summary());
            }
            if (serviceMetadata.documentationUrl() != null) {
                docs.documentationRootUrl(serviceMetadata.documentationUrl());
            }
            config.documentation(docs);
        }

        return new Service()
                .name(resourceName)
                .config(config)
                .state(convertServiceState(projectServiceState.state()))
                .parent("projects/" + projectServiceState.projectId());
    }

    private Service.StateEnum convertServiceState(com.gauthamchandra.serviceusage.model.ServiceState state) {
        return switch (state) {
            case ENABLED -> Service.StateEnum.ENABLED;
            case DISABLED -> Service.StateEnum.DISABLED;
        };
    }
}
