module Types exposing (Msg(..), Model, defaultModel)


type Msg
    = Increment
    | Decrement
    | SetName String


type alias Model =
    { count : Int
    , name : String
    }


defaultModel : Model
defaultModel =
    { count = 0
    , name = ""
    }
