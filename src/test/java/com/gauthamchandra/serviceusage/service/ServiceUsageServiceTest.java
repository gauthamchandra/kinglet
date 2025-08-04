package com.gauthamchandra.serviceusage.service;

import static org.junit.jupiter.api.Assertions.*;

import com.gauthamchandra.serviceusage.model.GcpService;
import com.gauthamchandra.serviceusage.model.ProjectServiceState;
import com.gauthamchandra.serviceusage.model.ServiceOperation;
import com.gauthamchandra.serviceusage.model.ServiceState;
import io.quarkus.test.junit.QuarkusTest;
import jakarta.inject.Inject;
import java.util.List;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

@QuarkusTest
class ServiceUsageServiceTest {

    @Inject
    ServiceUsageService serviceUsageService;

    @Test
    @DisplayName("enableService() - creates completed operation for valid service")
    void testEnableServiceCreatesCompletedOperationForValidService() {
        String projectId = "test-project";
        String serviceName = "secretmanager.googleapis.com";

        ServiceOperation result = serviceUsageService.enableService(projectId, serviceName);

        assertNotNull(result);
        assertTrue(result.isDone());
        assertFalse(result.isError());
        assertEquals(ServiceOperation.OperationType.ENABLE_SERVICE, result.type());
        assertEquals(projectId, result.projectId());
    }

    @Test
    @DisplayName("enableService() - throws exception for invalid service")
    void testEnableServiceThrowsExceptionForInvalidService() {
        String projectId = "test-project";
        String serviceName = "invalid.googleapis.com";

        IllegalArgumentException exception = assertThrows(
                IllegalArgumentException.class, () -> serviceUsageService.enableService(projectId, serviceName));

        assertEquals("Unknown service: invalid.googleapis.com", exception.getMessage());
    }

    @Test
    @DisplayName("disableService() - creates completed operation for valid service")
    void testDisableServiceCreatesCompletedOperationForValidService() {
        String projectId = "test-project";
        String serviceName = "secretmanager.googleapis.com";

        ServiceOperation result = serviceUsageService.disableService(projectId, serviceName);

        assertNotNull(result);
        assertTrue(result.isDone());
        assertFalse(result.isError());
        assertEquals(ServiceOperation.OperationType.DISABLE_SERVICE, result.type());
        assertEquals(projectId, result.projectId());
    }

    @Test
    @DisplayName("batchEnableServices() - enables multiple services and returns operation")
    void testBatchEnableServicesEnablesMultipleServicesAndReturnsOperation() {
        String projectId = "test-project";
        List<String> serviceNames = List.of("secretmanager.googleapis.com", "serviceusage.googleapis.com");

        ServiceOperation result = serviceUsageService.batchEnableServices(projectId, serviceNames);

        assertNotNull(result);
        assertTrue(result.isDone());
        assertFalse(result.isError());
        assertEquals(ServiceOperation.OperationType.BATCH_ENABLE_SERVICES, result.type());
        assertEquals(projectId, result.projectId());

        assertTrue(serviceUsageService.isServiceEnabled(projectId, "secretmanager.googleapis.com"));
        assertTrue(serviceUsageService.isServiceEnabled(projectId, "serviceusage.googleapis.com"));
    }

    @Test
    @DisplayName("batchDisableServices() - disables multiple services and returns operation")
    void testBatchDisableServicesDisablesMultipleServicesAndReturnsOperation() {
        String projectId = "test-project";
        List<String> serviceNames = List.of("secretmanager.googleapis.com", "serviceusage.googleapis.com");

        serviceUsageService.batchEnableServices(projectId, serviceNames);
        ServiceOperation result = serviceUsageService.batchDisableServices(projectId, serviceNames);

        assertNotNull(result);
        assertTrue(result.isDone());
        assertFalse(result.isError());
        assertEquals(ServiceOperation.OperationType.BATCH_DISABLE_SERVICES, result.type());

        assertFalse(serviceUsageService.isServiceEnabled(projectId, "secretmanager.googleapis.com"));
        assertFalse(serviceUsageService.isServiceEnabled(projectId, "serviceusage.googleapis.com"));
    }

    @Test
    @DisplayName("listServices() - returns all available services with states")
    void testListServicesReturnsAllAvailableServicesWithStates() {
        String projectId = "test-project-list-all";

        List<ProjectServiceState> result = serviceUsageService.listServices(projectId, null);

        assertTrue(result.size() >= 4);
        assertTrue(result.stream().allMatch(service -> service.state() == ServiceState.DISABLED));
    }

    @Test
    @DisplayName("listServices() - filters by enabled state")
    void testListServicesFiltersByEnabledState() {
        String projectId = "test-project";
        serviceUsageService.enableService(projectId, "secretmanager.googleapis.com");

        List<ProjectServiceState> result = serviceUsageService.listServices(projectId, "state:ENABLED");

        assertEquals(1, result.size());
        assertEquals("secretmanager.googleapis.com", result.get(0).serviceName());
        assertEquals(ServiceState.ENABLED, result.get(0).state());
    }

    @Test
    @DisplayName("listServices() - filters by disabled state")
    void testListServicesFiltersByDisabledState() {
        String projectId = "test-project-disabled";
        serviceUsageService.enableService(projectId, "secretmanager.googleapis.com");

        List<ProjectServiceState> result = serviceUsageService.listServices(projectId, "state:DISABLED");

        assertTrue(result.size() >= 3);
        assertTrue(result.stream().allMatch(service -> service.state() == ServiceState.DISABLED));
        assertFalse(result.stream().anyMatch(service -> service.serviceName().equals("secretmanager.googleapis.com")));
    }

    @Test
    @DisplayName("getOperation() - returns operation by name")
    void testGetOperationReturnsOperationByName() {
        String projectId = "test-project";
        String serviceName = "secretmanager.googleapis.com";

        ServiceOperation operation = serviceUsageService.enableService(projectId, serviceName);
        ServiceOperation result = serviceUsageService.getOperation(operation.name());

        assertEquals(operation.name(), result.name());
        assertEquals(operation.type(), result.type());
        assertEquals(operation.projectId(), result.projectId());
    }

    @Test
    @DisplayName("getOperation() - throws exception for non-existent operation")
    void testGetOperationThrowsExceptionForNonExistentOperation() {
        String operationName = "operations/non-existent";

        IllegalArgumentException exception =
                assertThrows(IllegalArgumentException.class, () -> serviceUsageService.getOperation(operationName));

        assertEquals("Operation not found: operations/non-existent", exception.getMessage());
    }

    @Test
    @DisplayName("getServiceMetadata() - returns service metadata")
    void testGetServiceMetadataReturnsServiceMetadata() {
        String serviceName = "secretmanager.googleapis.com";

        GcpService result = serviceUsageService.getServiceMetadata(serviceName);

        assertEquals("secretmanager.googleapis.com", result.name());
        assertEquals("Secret Manager API", result.title());
        assertNotNull(result.summary());
    }

    @Test
    @DisplayName("getServiceMetadata() - throws exception for non-existent service")
    void testGetServiceMetadataThrowsExceptionForNonExistentService() {
        String serviceName = "non-existent.googleapis.com";

        IllegalArgumentException exception =
                assertThrows(IllegalArgumentException.class, () -> serviceUsageService.getServiceMetadata(serviceName));

        assertEquals("Service not found: non-existent.googleapis.com", exception.getMessage());
    }

    @Test
    @DisplayName("isServiceEnabled() - returns correct status")
    void testIsServiceEnabledReturnsCorrectStatus() {
        String projectId = "test-project";
        String serviceName = "secretmanager.googleapis.com";

        assertFalse(serviceUsageService.isServiceEnabled(projectId, serviceName));

        serviceUsageService.enableService(projectId, serviceName);
        assertTrue(serviceUsageService.isServiceEnabled(projectId, serviceName));
    }

    @Test
    @DisplayName("validateServiceAccess() - throws exception for disabled service")
    void testValidateServiceAccessThrowsExceptionForDisabledService() {
        String projectId = "test-project-validate";
        String serviceName = "secretmanager.googleapis.com";

        IllegalArgumentException exception = assertThrows(
                IllegalArgumentException.class,
                () -> serviceUsageService.validateServiceAccess(projectId, serviceName));

        assertTrue(exception.getMessage().contains("is not enabled"));
    }
}
