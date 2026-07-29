from google.protobuf.internal import containers as _containers
from google.protobuf import descriptor as _descriptor
from google.protobuf import message as _message
from collections.abc import Iterable as _Iterable, Mapping as _Mapping
from typing import ClassVar as _ClassVar, Optional as _Optional, Union as _Union

DESCRIPTOR: _descriptor.FileDescriptor

class Address(_message.Message):
    __slots__ = ("line1", "line2", "city", "state", "country", "postal_code")
    LINE1_FIELD_NUMBER: _ClassVar[int]
    LINE2_FIELD_NUMBER: _ClassVar[int]
    CITY_FIELD_NUMBER: _ClassVar[int]
    STATE_FIELD_NUMBER: _ClassVar[int]
    COUNTRY_FIELD_NUMBER: _ClassVar[int]
    POSTAL_CODE_FIELD_NUMBER: _ClassVar[int]
    line1: str
    line2: str
    city: str
    state: str
    country: str
    postal_code: str
    def __init__(self, line1: _Optional[str] = ..., line2: _Optional[str] = ..., city: _Optional[str] = ..., state: _Optional[str] = ..., country: _Optional[str] = ..., postal_code: _Optional[str] = ...) -> None: ...

class TrackingRecord(_message.Message):
    __slots__ = ("id", "user_id", "order_id", "status", "datetime", "shipping_address", "cognito_sub")
    ID_FIELD_NUMBER: _ClassVar[int]
    USER_ID_FIELD_NUMBER: _ClassVar[int]
    ORDER_ID_FIELD_NUMBER: _ClassVar[int]
    STATUS_FIELD_NUMBER: _ClassVar[int]
    DATETIME_FIELD_NUMBER: _ClassVar[int]
    SHIPPING_ADDRESS_FIELD_NUMBER: _ClassVar[int]
    COGNITO_SUB_FIELD_NUMBER: _ClassVar[int]
    id: str
    user_id: str
    order_id: str
    status: str
    datetime: str
    shipping_address: Address
    cognito_sub: str
    def __init__(self, id: _Optional[str] = ..., user_id: _Optional[str] = ..., order_id: _Optional[str] = ..., status: _Optional[str] = ..., datetime: _Optional[str] = ..., shipping_address: _Optional[_Union[Address, _Mapping]] = ..., cognito_sub: _Optional[str] = ...) -> None: ...

class TrackingHistoryEntry(_message.Message):
    __slots__ = ("tracking_id", "user_id", "order_id", "status", "datetime", "cognito_sub")
    TRACKING_ID_FIELD_NUMBER: _ClassVar[int]
    USER_ID_FIELD_NUMBER: _ClassVar[int]
    ORDER_ID_FIELD_NUMBER: _ClassVar[int]
    STATUS_FIELD_NUMBER: _ClassVar[int]
    DATETIME_FIELD_NUMBER: _ClassVar[int]
    COGNITO_SUB_FIELD_NUMBER: _ClassVar[int]
    tracking_id: str
    user_id: str
    order_id: str
    status: str
    datetime: str
    cognito_sub: str
    def __init__(self, tracking_id: _Optional[str] = ..., user_id: _Optional[str] = ..., order_id: _Optional[str] = ..., status: _Optional[str] = ..., datetime: _Optional[str] = ..., cognito_sub: _Optional[str] = ...) -> None: ...

class TrackingWithHistory(_message.Message):
    __slots__ = ("tracking", "history")
    TRACKING_FIELD_NUMBER: _ClassVar[int]
    HISTORY_FIELD_NUMBER: _ClassVar[int]
    tracking: TrackingRecord
    history: _containers.RepeatedCompositeFieldContainer[TrackingHistoryEntry]
    def __init__(self, tracking: _Optional[_Union[TrackingRecord, _Mapping]] = ..., history: _Optional[_Iterable[_Union[TrackingHistoryEntry, _Mapping]]] = ...) -> None: ...

class CreateTrackingRequest(_message.Message):
    __slots__ = ("order_id", "user_id", "shipping_address", "test_mode", "cognito_sub")
    ORDER_ID_FIELD_NUMBER: _ClassVar[int]
    USER_ID_FIELD_NUMBER: _ClassVar[int]
    SHIPPING_ADDRESS_FIELD_NUMBER: _ClassVar[int]
    TEST_MODE_FIELD_NUMBER: _ClassVar[int]
    COGNITO_SUB_FIELD_NUMBER: _ClassVar[int]
    order_id: str
    user_id: str
    shipping_address: Address
    test_mode: bool
    cognito_sub: str
    def __init__(self, order_id: _Optional[str] = ..., user_id: _Optional[str] = ..., shipping_address: _Optional[_Union[Address, _Mapping]] = ..., test_mode: _Optional[bool] = ..., cognito_sub: _Optional[str] = ...) -> None: ...

class TrackingResponse(_message.Message):
    __slots__ = ("tracking",)
    TRACKING_FIELD_NUMBER: _ClassVar[int]
    tracking: TrackingRecord
    def __init__(self, tracking: _Optional[_Union[TrackingRecord, _Mapping]] = ...) -> None: ...

class GetTrackingByOrderIdRequest(_message.Message):
    __slots__ = ("order_id",)
    ORDER_ID_FIELD_NUMBER: _ClassVar[int]
    order_id: str
    def __init__(self, order_id: _Optional[str] = ...) -> None: ...

class TrackingWithHistoryResponse(_message.Message):
    __slots__ = ("tracking",)
    TRACKING_FIELD_NUMBER: _ClassVar[int]
    tracking: TrackingWithHistory
    def __init__(self, tracking: _Optional[_Union[TrackingWithHistory, _Mapping]] = ...) -> None: ...

class GetTrackingsByOrderIdsRequest(_message.Message):
    __slots__ = ("order_ids",)
    ORDER_IDS_FIELD_NUMBER: _ClassVar[int]
    order_ids: _containers.RepeatedScalarFieldContainer[str]
    def __init__(self, order_ids: _Optional[_Iterable[str]] = ...) -> None: ...

class TrackingsWithHistoryResponse(_message.Message):
    __slots__ = ("trackings",)
    TRACKINGS_FIELD_NUMBER: _ClassVar[int]
    trackings: _containers.RepeatedCompositeFieldContainer[TrackingWithHistory]
    def __init__(self, trackings: _Optional[_Iterable[_Union[TrackingWithHistory, _Mapping]]] = ...) -> None: ...
