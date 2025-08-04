package com.gauthamchandra.serviceusage.service;

import static org.junit.jupiter.api.Assertions.*;

import com.gauthamchandra.serviceusage.model.GcpService;
import com.gauthamchandra.serviceusage.model.ProjectServiceState;
import com.gauthamchandra.serviceusage.model.ServiceState;
import io.quarkus.test.junit.QuarkusTest;
import jakarta.inject.Inject;
import java.util.List;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

@QuarkusTest
class ServiceRegistryTest {

    @Inject
    ServiceRegistry serviceRegistry;

    @Test
    @DisplayName("isServiceEnabled() - returns false for disabled service")
    void testIsServiceEnabledReturnsFalseForDisabledService() {
        String projectId = "test-project-disabled";
        String serviceName = "secretmanager.googleapis.com";

        boolean result = serviceRegistry.isServiceEnabled(projectId, serviceName);

        assertFalse(result);
    }

    @Test
    @DisplayName("enableService() - enables a valid service")
    void testEnableServiceEnablesValidService() {
        String projectId = "test-project";
        String serviceName = "secretmanager.googleapis.com";

        serviceRegistry.enableService(projectId, serviceName);

        assertTrue(serviceRegistry.isServiceEnabled(projectId, serviceName));
    }

    @Test
    @DisplayName("enableService() - throws exception for invalid service")
    void testEnableServiceThrowsExceptionForInvalidService() {
        String projectId = "test-project";
        String serviceName = "invalid.googleapis.com";

        IllegalArgumentException exception = assertThrows(
                IllegalArgumentException.class, () -> serviceRegistry.enableService(projectId, serviceName));

        assertEquals("Unknown service: invalid.googleapis.com", exception.getMessage());
    }

    @Test
    @DisplayName("disableService() - disables an enabled service")
    void testDisableServiceDisablesEnabledService() {
        String projectId = "test-project";
        String serviceName = "secretmanager.googleapis.com";

        serviceRegistry.enableService(projectId, serviceName);
        assertTrue(serviceRegistry.isServiceEnabled(projectId, serviceName));

        serviceRegistry.disableService(projectId, serviceName);
        assertFalse(serviceRegistry.isServiceEnabled(projectId, serviceName));
    }

    @Test
    @DisplayName("enableServices() - enables multiple services in batch")
    void testEnableServicesBatchEnablesMultipleServices() {
        String projectId = "test-project";
        List<String> serviceNames = List.of("secretmanager.googleapis.com", "serviceusage.googleapis.com");

        serviceRegistry.enableServices(projectId, serviceNames);

        assertTrue(serviceRegistry.isServiceEnabled(projectId, "secretmanager.googleapis.com"));
        assertTrue(serviceRegistry.isServiceEnabled(projectId, "serviceusage.googleapis.com"));
    }

    @Test
    @DisplayName("disableServices() - disables multiple services in batch")
    void testDisableServicesBatchDisablesMultipleServices() {
        String projectId = "test-project";
        List<String> serviceNames = List.of("secretmanager.googleapis.com", "serviceusage.googleapis.com");

        serviceRegistry.enableServices(projectId, serviceNames);
        serviceRegistry.disableServices(projectId, serviceNames);

        assertFalse(serviceRegistry.isServiceEnabled(projectId, "secretmanager.googleapis.com"));
        assertFalse(serviceRegistry.isServiceEnabled(projectId, "serviceusage.googleapis.com"));
    }

    @Test
    @DisplayName("listProjectServices() - returns enabled services for project")
    void testListProjectServicesReturnsEnabledServicesForProject() {
        String projectId = "test-project";
        serviceRegistry.enableService(projectId, "secretmanager.googleapis.com");

        List<ProjectServiceState> services = serviceRegistry.listProjectServices(projectId);

        assertEquals(1, services.size());
        assertEquals("secretmanager.googleapis.com", services.get(0).serviceName());
        assertEquals(ServiceState.ENABLED, services.get(0).state());
    }

    @Test
    @DisplayName("listProjectServices() - filters by service state")
    void testListProjectServicesFiltersByServiceState() {
        String projectId = "test-project";
        serviceRegistry.enableService(projectId, "secretmanager.googleapis.com");
        serviceRegistry.disableService(projectId, "serviceusage.googleapis.com");

        List<ProjectServiceState> enabledServices =
                serviceRegistry.listProjectServices(projectId, ServiceState.ENABLED);
        List<ProjectServiceState> disabledServices =
                serviceRegistry.listProjectServices(projectId, ServiceState.DISABLED);

        assertEquals(1, enabledServices.size());
        assertEquals("secretmanager.googleapis.com", enabledServices.get(0).serviceName());

        assertEquals(1, disabledServices.size());
        assertEquals("serviceusage.googleapis.com", disabledServices.get(0).serviceName());
    }

    @Test
    @DisplayName("listAvailableServices() - returns all predefined services")
    void testListAvailableServicesReturnsAllPredefinedServices() {
        List<GcpService> services = serviceRegistry.listAvailableServices();

        assertTrue(services.size() >= 4);
        List<String> serviceNames = services.stream().map(GcpService::name).toList();
        assertTrue(serviceNames.contains("secretmanager.googleapis.com"));
        assertTrue(serviceNames.contains("serviceusage.googleapis.com"));
    }

    @Test
    @DisplayName("validateServiceAccess() - throws exception for disabled service")
    void testValidateServiceAccessThrowsExceptionForDisabledService() {
        String projectId = "test-project-validate-disabled";
        String serviceName = "secretmanager.googleapis.com";

        IllegalArgumentException exception = assertThrows(
                IllegalArgumentException.class, () -> serviceRegistry.validateServiceAccess(projectId, serviceName));

        assertTrue(exception.getMessage().contains("is not enabled"));
    }

    @Test
    @DisplayName("validateServiceAccess() - passes for enabled service")
    void testValidateServiceAccessPassesForEnabledService() {
        String projectId = "test-project";
        String serviceName = "secretmanager.googleapis.com";

        serviceRegistry.enableService(projectId, serviceName);

        assertDoesNotThrow(() -> serviceRegistry.validateServiceAccess(projectId, serviceName));
    }
}
