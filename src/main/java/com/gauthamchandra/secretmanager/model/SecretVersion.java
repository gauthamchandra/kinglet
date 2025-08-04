package com.gauthamchandra.secretmanager.model;

import java.time.OffsetDateTime;

public record SecretVersion(
        int versionNumber, String data, VersionState state, OffsetDateTime createTime, OffsetDateTime destroyTime) {

    public enum VersionState {
        ENABLED,
        DISABLED,
        DESTROYED
    }

    public static SecretVersion create(int versionNumber, String data) {
        return new SecretVersion(versionNumber, data, VersionState.ENABLED, OffsetDateTime.now(), null);
    }

    public SecretVersion withState(VersionState newState) {
        return new SecretVersion(
                versionNumber,
                data,
                newState,
                createTime,
                newState == VersionState.DESTROYED ? OffsetDateTime.now() : destroyTime);
    }

    public String getName(String project, String secretName) {
        return String.format("projects/%s/secrets/%s/versions/%d", project, secretName, versionNumber);
    }

    public boolean isAccessible() {
        return state == VersionState.ENABLED;
    }

    public boolean isDestroyed() {
        return state == VersionState.DESTROYED;
    }
}
